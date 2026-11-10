/**
 * Draws a trace state and measures it. Each render copies the base frame
 * and each open overlay into a scratch container the size of the viewport,
 * applies the state to the copies (variant overrides, modes, assigned
 * variable values, scroll), measures every layer of the copies, exports
 * the container, and removes it in a `finally`. The originals are never
 * touched. Renders and reads run one at a time, through one queue.
 *
 * Layers are measured under their logical keys, and with their logical
 * types: the original layer's, found by walking original and copy in
 * parallel; inside an instance whose variant was swapped, the key is
 * `<instance key>;<path>`, the path being the copy's id after Figma's
 * `I<instance>;` prefix (the reader keys the variant's reactions by the
 * same path). An instance the render had to detach on the copy keeps the
 * keys and types its layers had before.
 */

import { activeMode, type ExprScope, findVariable, readVariable } from '../lib/proto/expr';
import type { Box, ProtoDoc, RawLayer, RoleHint, ScrollOffset, Size, TraceState, VariableLiteral, RGBA } from '../lib/proto/model';
import { reactionsFor } from '../lib/proto/variants';
import { pageOf } from './document';
import { exclusive, holdContainer, recordScratchNode, releaseContainer, SCRATCH_KEY, SCRATCH_VALUE } from './scratch';

export interface RenderNote {
  /** Fonts that aren't available here: text set in them was left as designed. */
  missing_font: string[];
}

export interface RenderResult {
  image: Uint8Array;
  layers: RawLayer[];
  viewport: Size;
  notes: RenderNote[];
}

export interface Renderer {
  render(doc: ProtoDoc, state: TraceState): Promise<RenderResult>;
}

/** Where the container sits: far off the canvas, so nobody sees it while it lives. */
const CONTAINER_X = -100_000;

/** Exported as JPEG at 1x. Figma's plugin export has no JPEG quality setting; it uses its own. */
const EXPORT: ExportSettingsImage = { format: 'JPG', constraint: { type: 'SCALE', value: 1 } };

/** The largest screenshot a turn can carry. */
const MAX_SCREENSHOT_BYTES = 1.5 * 1024 * 1024;

const VECTOR_TYPES: ReadonlySet<string> = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON']);
const INPUT_NAME = /\b(input|field|text ?box|search ?bar)\b/i;
const CONTROL_NAME = /\b(button|btn|cta|toggle|switch|checkbox|radio)\b/i;
const CARD_NAME = /\bcard\b/i;
/** The largest box an unlabelled shape can have and still read as an icon. */
const ICON_SIZE = 48;

type Screen = FrameNode | ComponentNode | InstanceNode;
type Paints = ReadonlyArray<Paint>;

interface Copy {
  frameId: string;
  root: Screen;
}

interface Render {
  api: PluginAPI;
  doc: ProtoDoc;
  state: TraceState;
  keyOf: Map<SceneNode, string>;
  /** The type each copied layer is measured with: its original's (a component copied inside a frame becomes an instance). */
  typeOf: Map<SceneNode, string>;
  byKey: Map<string, SceneNode>;
  missingFonts: Set<string>;
}

export function createRenderer(api: PluginAPI): Renderer {
  return { render: (doc, state) => exclusive(api, () => renderOnce(api, doc, state)) };
}

async function renderOnce(api: PluginAPI, doc: ProtoDoc, state: TraceState): Promise<RenderResult> {
  const { width, height } = state.viewport;
  const shown = [state.frameId, ...state.overlays.map((o) => o.frameId)];
  const twice = shown.find((id, i) => shown.indexOf(id) !== i);
  if (twice !== undefined) throw new Error(`The frame ${twice} is open twice on this screen, so its layers would share keys`);
  const container = api.createFrame();
  recordScratchNode(container.id);
  holdContainer(container);
  try {
    container.name = 'Archetype trace (scratch)';
    container.setPluginData(SCRATCH_KEY, SCRATCH_VALUE);
    container.x = CONTAINER_X;
    container.y = 0;
    container.resize(width, height);
    container.clipsContent = true;
    container.locked = true;

    const r: Render = { api, doc, state, keyOf: new Map(), typeOf: new Map(), byKey: new Map(), missingFonts: new Set() };
    // A page offset moves its frame's copy up and left: the base frame's, and an overlay's bigger than the viewport.
    const pageOf = (frameId: string) => state.scroll[frameId] ?? { x: 0, y: 0 };
    const base = pageOf(state.frameId);
    const { copy: baseCopy, page } = await copyInto(r, container, state.frameId, { x: -base.x, y: -base.y });
    // What shows around a frame narrower than the viewport: the prototype's background, as in the viewer.
    container.fills = [...page.prototypeBackgrounds];
    const copies: Copy[] = [{ frameId: state.frameId, root: baseCopy }];
    for (const overlay of state.overlays) {
      const frame = doc.frames.find((f) => f.id === overlay.frameId);
      if (!frame) throw new Error(`The overlay ${overlay.frameId} isn't in the prototype`);
      if (frame.overlay.background.type === 'SOLID_COLOR') backdrop(api, container, state.viewport, frame.overlay.background.color);
      const offset = pageOf(overlay.frameId);
      const { copy } = await copyInto(r, container, overlay.frameId, { x: overlay.origin.x - offset.x, y: overlay.origin.y - offset.y });
      copies.push({ frameId: overlay.frameId, root: copy });
    }

    for (const copy of copies) {
      await applyVariants(r, copy);
      await applyModes(r, copy);
      await applyValues(r, copy);
      applyScroll(r, copy, pageOf(copy.frameId));
    }

    const layers: RawLayer[] = [];
    for (const copy of copies) layers.push(...measure(r, copy, container));
    const image = await container.exportAsync(EXPORT);
    if (!image.length) throw new Error('The export of the screen came back empty');
    if (image.length > MAX_SCREENSHOT_BYTES) throw new Error(`The screenshot is ${image.length} bytes, over the 1.5 MiB a turn can carry`);
    const notes = r.missingFonts.size ? [{ missing_font: [...r.missingFonts] }] : [];
    return { image, layers, viewport: { width, height }, notes };
  } finally {
    // Gone already when the plugin closed mid-render and the close handler removed it.
    if (!container.removed) container.remove();
    releaseContainer(container);
    // So the designer's next undo can't bring the copies back.
    api.commitUndo();
  }
}

// --- Copies ------------------------------------------------------------------------------

function isScreen(node: BaseNode | null): node is Screen {
  return !!node && (node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE');
}

function nodeAt(r: Render, key: string): SceneNode {
  const node = r.byKey.get(key);
  if (!node) throw new Error(`The layer ${key} isn't on the screen any more`);
  return node;
}

function setKey(r: Render, node: SceneNode, key: string, type: string): void {
  r.keyOf.set(node, key);
  r.typeOf.set(node, type);
  r.byKey.set(key, node);
}

/** Keys a copy by its original's ids, and types it by its original's type, walking both in parallel. */
function keyByOriginal(r: Render, original: SceneNode, copy: SceneNode): void {
  setKey(r, copy, original.id, original.type);
  const from = 'children' in original ? original.children : [];
  const to = 'children' in copy ? copy.children : [];
  if (from.length !== to.length) throw new Error(`The copy of ${original.id} doesn't have its original's layers`);
  from.forEach((child, i) => keyByOriginal(r, child, to[i] as SceneNode));
}

async function copyInto(r: Render, container: FrameNode, frameId: string, at: { x: number; y: number }): Promise<{ copy: Screen; page: PageNode }> {
  const original = await r.api.getNodeByIdAsync(frameId);
  if (!isScreen(original) || original.removed) throw new Error(`The frame ${frameId} isn't in the file any more`);
  const page = pageOf(original);
  if (!page) throw new Error(`The frame ${frameId} is on no page`);
  if (page !== r.api.currentPage) await page.loadAsync();
  const copy = original.clone();
  recordScratchNode(copy.id);
  container.appendChild(copy);
  copy.x = at.x;
  copy.y = at.y;
  keyByOriginal(r, original, copy);
  return { copy, page };
}

/** The dimming behind an overlay that has a background. */
function backdrop(api: PluginAPI, container: FrameNode, viewport: Size, color: RGBA): void {
  const rect = api.createRectangle();
  recordScratchNode(rect.id);
  container.appendChild(rect);
  rect.x = 0;
  rect.y = 0;
  rect.resize(viewport.width, viewport.height);
  rect.fills = [{ type: 'SOLID', color: { r: color.r, g: color.g, b: color.b }, opacity: color.a }];
}

function* subtree(node: SceneNode): Generator<SceneNode> {
  yield node;
  if ('children' in node) for (const child of node.children) yield* subtree(child);
}

/** Overrides go outer instance first, since a nested instance's key only exists once its parent is swapped. */
async function applyVariants(r: Render, copy: Copy): Promise<void> {
  const overrides = Object.entries(r.state.variants[copy.frameId] ?? {}).sort(([a], [b]) => a.length - b.length);
  for (const [instanceKey, variantId] of overrides) {
    const instance = nodeAt(r, instanceKey);
    if (instance.type !== 'INSTANCE') throw new Error(`The layer ${instanceKey} isn't an instance any more`);
    const variant = r.doc.variantSets[instanceKey]?.variants.find((v) => v.id === variantId);
    if (!variant?.componentId) throw new Error(`Variant ${variantId} of ${instanceKey} can't be shown`);
    const component = await r.api.getNodeByIdAsync(variant.componentId);
    if (!component || component.type !== 'COMPONENT') throw new Error(`The component ${variant.componentId} isn't in the file any more`);

    for (const old of subtree(instance)) if (old !== instance) r.byKey.delete(r.keyOf.get(old) as string);
    instance.swapComponent(component);
    const prefix = `${instance.id.startsWith('I') ? instance.id : `I${instance.id}`};`;
    for (const layer of subtree(instance)) {
      if (layer === instance) continue;
      if (!layer.id.startsWith(prefix)) throw new Error(`The layer ${layer.id} in instance ${instance.id} has an id Figma doesn't give instance layers`);
      setKey(r, layer, `${instanceKey};${layer.id.slice(prefix.length)}`, layer.type);
    }
  }
}

/** The copy gets the mode the engine reads its frame in: the frame's own, else the one the state chose, else the page's. */
async function applyModes(r: Render, copy: Copy): Promise<void> {
  const scope: ExprScope = { doc: r.doc, state: r.state, frameId: copy.frameId };
  for (const collection of Object.values(r.doc.variableCollections)) {
    const mode = activeMode(scope, collection);
    const live = await r.api.variables.getVariableCollectionByIdAsync(collection.id);
    if (!live) throw new Error(`The variable collection ${collection.name} isn't in the file any more`);
    copy.root.setExplicitVariableModeForCollection(live, mode);
  }
}

// --- Assigned variable values ------------------------------------------------------------------

/** Whether the variable's value in this frame comes from SET_VARIABLE, directly or through an alias. */
function assigned(scope: ExprScope, variableId: string, seen: string[] = []): boolean {
  if (seen.includes(variableId) || !Object.values(scope.doc.variableCollections).some((c) => c.variables[variableId])) return false;
  const { collection, def } = findVariable(scope.doc, variableId);
  const mode = activeMode(scope, collection);
  if (scope.state.variables[collection.id]?.[mode]?.[variableId] !== undefined) return true;
  const value = def.valuesByMode[mode];
  return typeof value === 'object' && value !== null && 'alias' in value ? assigned(scope, value.alias, [...seen, variableId]) : false;
}

/** The numeric fields of Figma's `VariableBindableNodeField`. */
const NUMERIC_FIELDS: ReadonlySet<string> = new Set([
  'width',
  'height',
  'minWidth',
  'maxWidth',
  'minHeight',
  'maxHeight',
  'itemSpacing',
  'counterAxisSpacing',
  'paddingLeft',
  'paddingRight',
  'paddingTop',
  'paddingBottom',
  'cornerRadius',
  'topLeftRadius',
  'topRightRadius',
  'bottomLeftRadius',
  'bottomRightRadius',
  'strokeWeight',
  'strokeTopWeight',
  'strokeRightWeight',
  'strokeBottomWeight',
  'strokeLeftWeight',
  'opacity',
  'gridRowGap',
  'gridColumnGap',
]);

const fontName = (f: FontName) => `${f.family} ${f.style}`;

/** The render can't draw this assigned value; the session ends the run with `render_failed` and this as the detail. */
function cantShow(r: Render, node: SceneNode, field: string, why: string): Error {
  return new Error(`The render can't show the variable assigned to ${field} of layer ${r.keyOf.get(node) ?? node.id}: ${why}`);
}

/** Writes text, first loading its fonts; with a font missing the text stays as designed and the render notes it. */
async function writeText(r: Render, node: TextNode, text: string): Promise<void> {
  const fonts = node.characters.length ? node.getRangeAllFontNames(0, node.characters.length) : [node.fontName as FontName];
  if (node.hasMissingFont) {
    for (const f of fonts) r.missingFonts.add(fontName(f));
    return;
  }
  for (const f of fonts) await r.api.loadFontAsync(f);
  node.setBoundVariable('characters', null);
  node.characters = text;
}

function recolour(r: Render, scope: ExprScope, node: SceneNode, field: string, paints: Paints): Paints | null {
  let changed = false;
  const out = paints.map((paint): Paint => {
    if (paint.type !== 'SOLID') {
      const stops = 'gradientStops' in paint ? paint.gradientStops : [];
      if (stops.some((stop) => stop.boundVariables?.color && assigned(scope, stop.boundVariables.color.id))) {
        throw cantShow(r, node, field, 'it is bound to a gradient stop');
      }
      return paint;
    }
    const alias = paint.boundVariables?.color;
    if (!alias || !assigned(scope, alias.id)) return paint;
    const value = readVariable(scope, alias.id, null);
    if (typeof value !== 'object') throw cantShow(r, node, field, `a ${typeof value} is no colour`);
    changed = true;
    // A paint without `boundVariables` is unbound.
    const unbound: { -readonly [K in keyof SolidPaint]?: SolidPaint[K] } = { ...paint };
    delete unbound.boundVariables;
    return { ...unbound, type: 'SOLID', color: { r: value.r, g: value.g, b: value.b }, opacity: value.a };
  });
  return changed ? out : null;
}

/** Writes values bound to an instance's component properties through `setProperties`, as the properties panel does. */
function writeProperties(r: Render, scope: ExprScope, node: SceneNode, bound: Record<string, VariableAlias>): void {
  for (const [name, alias] of Object.entries(bound)) {
    if (!assigned(scope, alias.id)) continue;
    if (node.type !== 'INSTANCE') throw cantShow(r, node, `component property ${name}`, 'the layer is no instance');
    const property = node.componentProperties[name];
    if (!property) throw cantShow(r, node, `component property ${name}`, 'the instance has no such property');
    const value = readVariable(scope, alias.id, null);
    const fits = property.type === 'BOOLEAN' ? typeof value === 'boolean' : typeof value === 'string' || typeof value === 'number';
    if (!fits) throw cantShow(r, node, `component property ${name}`, `a ${typeof value} doesn't fit a ${property.type} property`);
    node.setProperties({ [name]: typeof value === 'number' ? `${value}` : (value as string | boolean) });
  }
}

/**
 * For each variable SET_VARIABLE assigned, the bound property is unbound
 * on the copy and the computed value written: text, visibility, solid
 * paint colours, component properties and every numeric field. A value
 * the copy can't take (a typography, effect, grid or text range binding,
 * or a value of the wrong type) fails the render, naming field and layer.
 */
async function applyValues(r: Render, copy: Copy): Promise<void> {
  if (!Object.keys(r.state.variables).length) return;
  const scope: ExprScope = { doc: r.doc, state: r.state, frameId: copy.frameId };
  for (const node of subtree(copy.root)) {
    for (const field of ['fills', 'strokes'] as const) {
      if (!(field in node)) continue;
      const paints = (node as GeometryMixin)[field];
      if (!Array.isArray(paints)) continue;
      const next = recolour(r, scope, node, field, paints);
      if (next) (node as GeometryMixin)[field] = next;
    }
    const bound = (node as SceneNode & { boundVariables?: Record<string, unknown> }).boundVariables ?? {};
    for (const [field, binding] of Object.entries(bound)) {
      // Paint bindings live on the paints, handled above.
      if (field === 'fills' || field === 'strokes') continue;
      if (field === 'componentProperties') {
        writeProperties(r, scope, node, binding as Record<string, VariableAlias>);
        continue;
      }
      const aliases = (Array.isArray(binding) ? binding : [binding]) as VariableAlias[];
      const hit = aliases.find((a) => assigned(scope, a.id));
      if (!hit) continue;
      const value: VariableLiteral = readVariable(scope, hit.id, null);
      if (field === 'characters' && node.type === 'TEXT' && (typeof value === 'string' || typeof value === 'number')) {
        await writeText(r, node, `${value}`);
      } else if (field === 'visible' && typeof value === 'boolean') {
        node.setBoundVariable('visible', null);
        node.visible = value;
      } else if (NUMERIC_FIELDS.has(field) && typeof value === 'number') {
        node.setBoundVariable(field as VariableBindableNodeField, null);
        if (field === 'width' || field === 'height') {
          const sized = node as SceneNode & LayoutMixin;
          sized.resize(field === 'width' ? value : sized.width, field === 'height' ? value : sized.height);
        } else {
          (node as unknown as Record<string, number>)[field] = value;
        }
      } else {
        throw cantShow(r, node, field, NUMERIC_FIELDS.has(field) || field === 'characters' || field === 'visible' ? `a ${typeof value} doesn't fit` : 'the render writes no such binding');
      }
    }
  }
}

// --- Scroll ---------------------------------------------------------------------------------------

/** Fixed children are the last `numberOfFixedChildren` of a frame: Figma draws them over the scrolling ones. */
function fixedChildren(node: SceneNode): Set<SceneNode> {
  if (!('numberOfFixedChildren' in node) || !node.numberOfFixedChildren) return new Set();
  const kids = (node as FrameNode).children;
  return new Set(kids.slice(kids.length - node.numberOfFixedChildren));
}

/**
 * Figma refuses to move the layers inside an instance or change their auto
 * layout. Before the render moves anything around `node`, it detaches on
 * the copy every instance at or above it, outermost first; the detached
 * layers get new ids, so they take over the keys and types their layers
 * had, walking the layers before and after in parallel. Returns the node
 * now standing for `node`.
 */
function freed(r: Render, copy: Copy, node: SceneNode): SceneNode {
  const key = r.keyOf.get(node) as string;
  for (;;) {
    const current = nodeAt(r, key);
    let outer: InstanceNode | null = null;
    for (let n: BaseNode | null = current; n && n !== copy.root.parent; n = n.parent) if (n.type === 'INSTANCE') outer = n as InstanceNode;
    if (!outer) return current;
    const before = [...subtree(outer)].map((n) => ({ key: r.keyOf.get(n) as string, type: r.typeOf.get(n) as string }));
    for (const { key: old } of before) r.byKey.delete(old);
    const isRoot = outer === copy.root;
    const frame = outer.detachInstance();
    recordScratchNode(frame.id);
    const after = [...subtree(frame)];
    if (after.length !== before.length) throw new Error(`Detaching ${before[0]?.key} on the copy changed its layers`);
    after.forEach((n, i) => setKey(r, n, (before[i] as { key: string }).key, (before[i] as { type: string }).type));
    if (isRoot) copy.root = frame;
  }
}

/** Moves children by hand: auto layout would put them back, so the copy's auto layout is frozen first. */
function shift(r: Render, copy: Copy, node: SceneNode, pick: (area: SceneNode) => SceneNode[], dx: number, dy: number): void {
  if ((dx === 0 && dy === 0) || !pick(node).length) return;
  const area = freed(r, copy, node);
  if ('layoutMode' in area && area.layoutMode !== 'NONE') (area as FrameNode).layoutMode = 'NONE';
  for (const child of pick(area)) {
    child.x += dx;
    child.y += dy;
  }
}

/**
 * The page offset moved the copy up and left; its fixed children move back
 * by as much, so they stay put on screen. Each scrolled area's content
 * moves by its offset, its fixed children staying.
 */
function applyScroll(r: Render, copy: Copy, page: ScrollOffset): void {
  shift(r, copy, copy.root, (root) => [...fixedChildren(root)], page.x, page.y);
  for (const [key, offset] of Object.entries(r.state.scroll[copy.frameId]?.areas ?? {})) {
    const area = nodeAt(r, key);
    if (!('children' in area)) throw new Error(`The scroll area ${key} has no layers to scroll`);
    const scrolling = (a: SceneNode) => {
      const fixed = fixedChildren(a);
      return (a as FrameNode).children.filter((c) => !fixed.has(c));
    };
    shift(r, copy, area, scrolling, -offset.x, -offset.y);
  }
}

// --- Measuring -------------------------------------------------------------------------------------

function boxIn(node: SceneNode, origin: Rect): Box {
  const abs = node.absoluteBoundingBox;
  if (!abs) throw new Error(`The layer ${node.id} has no box`);
  return { x: abs.x - origin.x, y: abs.y - origin.y, width: abs.width, height: abs.height };
}

function intersect(a: Box, b: Box): Box | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

const visiblePaint = (paints: unknown) => Array.isArray(paints) && paints.some((p: Paint) => p.visible !== false && (p.opacity ?? 1) > 0);

/** Whether a layer draws anything of its own: a visible fill, stroke or effect, or text. */
function paintsOf(node: SceneNode): boolean {
  if ('opacity' in node && node.opacity === 0) return false;
  if (node.type === 'TEXT') return node.characters.trim() !== '';
  if ('fills' in node && visiblePaint(node.fills)) return true;
  // A stroke of mixed weights (figma.mixed) has some side drawn.
  if ('strokes' in node && visiblePaint(node.strokes) && (typeof node.strokeWeight !== 'number' || node.strokeWeight > 0)) return true;
  return 'effects' in node && node.effects.some((e) => e.visible);
}

const hasText = (node: SceneNode) => [...subtree(node)].some((n) => n.type === 'TEXT');

function roleHintOf(node: SceneNode): RoleHint | null {
  if ('fills' in node && Array.isArray(node.fills) && node.fills.some((p: Paint) => p.type === 'IMAGE' && p.visible !== false)) return 'image';
  if (node.type === 'TEXT') return node.textDecoration === 'UNDERLINE' ? 'link' : 'text';
  if (INPUT_NAME.test(node.name)) return 'input';
  if (CONTROL_NAME.test(node.name)) return 'button';
  if (VECTOR_TYPES.has(node.type)) return 'icon';
  const small = 'width' in node && node.width <= ICON_SIZE && node.height <= ICON_SIZE;
  if (small && (node.type === 'FRAME' || node.type === 'INSTANCE' || node.type === 'COMPONENT' || node.type === 'GROUP') && !hasText(node)) return 'icon';
  if (CARD_NAME.test(node.name)) return 'card';
  return null;
}

/**
 * How far a nested scrolling frame's content (its visible, non-fixed
 * children) reaches past it, at offset zero. A root has none: a top level
 * frame scrolls as a page, by its own size.
 */
function scrollOf(r: Render, copy: Copy, node: SceneNode, key: string, origin: Rect): RawLayer['scroll'] {
  if (node === copy.root || !('overflowDirection' in node) || node.overflowDirection === 'NONE' || !('children' in node)) return null;
  const own = boxIn(node, origin);
  const offset = r.state.scroll[copy.frameId]?.areas[key] ?? { x: 0, y: 0 };
  const fixed = fixedChildren(node);
  let right = 0;
  let bottom = 0;
  for (const child of node.children) {
    if (fixed.has(child) || !child.visible) continue;
    const b = boxIn(child, origin);
    right = Math.max(right, b.x - own.x + offset.x + b.width);
    bottom = Math.max(bottom, b.y - own.y + offset.y + b.height);
  }
  return { direction: node.overflowDirection, maxX: Math.max(0, right - own.width), maxY: Math.max(0, bottom - own.height) };
}

/**
 * Every layer of a copy in paint order (a layer, then its children from
 * the bottom up; `itemReverseZIndex` draws the first child on top), boxes
 * in viewport coordinates.
 */
function measure(r: Render, copy: Copy, container: FrameNode): RawLayer[] {
  const origin = container.absoluteBoundingBox as Rect;
  const layers: RawLayer[] = [];
  const walk = (node: SceneNode, parentKey: string | null, clip: Box | null, fixed: boolean) => {
    const key = r.keyOf.get(node);
    const type = r.typeOf.get(node);
    if (key === undefined || type === undefined) throw new Error(`The copied layer ${node.id} has no key`);
    const unclippedBox = boxIn(node, origin);
    const box = clip ? (intersect(unclippedBox, clip) ?? { x: unclippedBox.x, y: unclippedBox.y, width: 0, height: 0 }) : unclippedBox;
    layers.push({
      key,
      type,
      name: node.name,
      text: node.type === 'TEXT' ? node.characters : null,
      box,
      unclippedBox,
      visible: node.visible,
      paints: paintsOf(node),
      hasReactions: reactionsFor(r.doc, r.state, key).length > 0,
      roleHint: roleHintOf(node),
      parentKey,
      scroll: scrollOf(r, copy, node, key, origin),
      fixed,
    });
    if (!('children' in node)) return;
    const inner = 'clipsContent' in node && node.clipsContent ? (clip ? (intersect(clip, unclippedBox) ?? { ...box, width: 0, height: 0 }) : unclippedBox) : clip;
    const pinned = fixedChildren(node);
    const bottomUp = 'itemReverseZIndex' in node && node.itemReverseZIndex ? [...node.children].reverse() : node.children;
    for (const child of bottomUp) walk(child, key, inner, pinned.has(child));
  };
  walk(copy.root, null, null, false);
  return layers;
}
