/**
 * Reads the prototype on a page into a plain `ProtoDoc` for the trace
 * engine: the page's top level frames and the frames on other pages its
 * reactions reach, every reaction of every layer in them, the variants a
 * CHANGE_TO can show, and the local variables. It runs with every layer
 * inside instances reachable, and skips the renderer's scratch container.
 *
 * Inside a variant, a layer is keyed by its path: its id with Figma's
 * leading `I` dropped (`I12:3;4:5` is the path `12:3;4:5`), which is what
 * the renderer appends to an instance's key for the same layer once the
 * instance shows that variant.
 */

import { hashText, stableJson } from '../lib/proto/hash';
import type {
  LibraryVariant,
  OverlayBackground as ProtoBackground,
  ProtoAction,
  ProtoDoc,
  ProtoFrame,
  ProtoReaction,
  ProtoTrigger,
  ProtoVariant,
  RGBA,
  VariableCollection as ProtoCollection,
  VariableDef,
  VariableExpr,
  VariableExprOperator,
  VariableType,
  VariableValue as ProtoValue,
  VariantSet,
} from '../lib/proto/model';
import { pageOf, topFrameOf, topLevelFrames } from './document';
import { exclusive, isScratch } from './scratch';

export interface ReadOptions {
  /** Whether the read may import library variants, which adds them to the designer's file. */
  importLibraryVariants: boolean;
}

const OPERATORS: ReadonlySet<string> = new Set<VariableExprOperator>([
  'ADDITION',
  'SUBTRACTION',
  'MULTIPLICATION',
  'DIVISION',
  'EQUALS',
  'NOT_EQUAL',
  'LESS_THAN',
  'LESS_THAN_OR_EQUAL',
  'GREATER_THAN',
  'GREATER_THAN_OR_EQUAL',
  'AND',
  'OR',
  'NOT',
  'NEGATE',
  'VAR_MODE_LOOKUP',
]);

const VARIABLE_TYPES: ReadonlySet<string> = new Set<VariableType>(['BOOLEAN', 'FLOAT', 'STRING', 'COLOR']);

type Reactive = SceneNode & ReactionMixin;
type Screen = FrameNode | ComponentNode | InstanceNode;

// --- Plain data from Figma's ------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';
const isColor = (v: unknown): v is RGB | RGBA => isObject(v) && typeof v.r === 'number' && typeof v.g === 'number' && typeof v.b === 'number';
const rgba = (c: RGB | RGBA): RGBA => ({ r: c.r, g: c.g, b: c.b, a: 'a' in c ? c.a : 1 });

function trigger(t: Trigger): ProtoTrigger {
  switch (t.type) {
    case 'ON_CLICK':
    case 'ON_HOVER':
    case 'ON_PRESS':
    case 'ON_DRAG':
    case 'ON_MEDIA_END':
      return { type: t.type };
    case 'AFTER_TIMEOUT':
      // Figma stores timeouts and delays in milliseconds.
      return { type: t.type, delayMs: t.timeout };
    case 'MOUSE_UP':
    case 'MOUSE_DOWN':
      return { type: t.type, delayMs: t.delay };
    case 'MOUSE_ENTER':
    case 'MOUSE_LEAVE':
      return { type: t.type, delayMs: t.delay, deprecatedVersion: t.deprecatedVersion };
    case 'ON_KEY_DOWN':
      return { type: t.type, device: t.device, keyCodes: [...t.keyCodes] };
    case 'ON_MEDIA_HIT':
      return { type: t.type, mediaHitTime: t.mediaHitTime };
    default:
      return { type: 'UNKNOWN', rawType: (t as { type: string }).type };
  }
}

function expression(data: VariableData | undefined): VariableExpr {
  const value: unknown = data?.value;
  if (value === undefined) return { kind: 'unsupported', detail: 'a missing value' };
  if (isObject(value) && 'expressionFunction' in value) {
    const fn = String(value.expressionFunction);
    if (!OPERATORS.has(fn)) return { kind: 'unsupported', detail: `the expression function ${fn}` };
    if (!Array.isArray(value.expressionArguments)) throw new Error(`The expression ${fn} has no arguments`);
    const args = value.expressionArguments as VariableData[];
    return { kind: 'op', operator: fn as VariableExprOperator, operands: args.map(expression) };
  }
  if (isObject(value) && value.type === 'VARIABLE_ALIAS') return { kind: 'alias', variableId: String(value.id) };
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return { kind: 'literal', value };
  if (isColor(value)) return { kind: 'literal', value: rgba(value) };
  return { kind: 'unsupported', detail: `a ${data?.type ?? 'value'} value` };
}

function nodeAction(a: Extract<Action, { type: 'NODE' }>): ProtoAction {
  // Figma leaves these out when they are unset. resetScrollPosition decides
  // when it is there; an old file that has only the deprecated
  // preserveScrollPosition resets unless it preserves; with neither, the
  // scroll resets, as a navigation does in Figma by default.
  const reset = a.resetScrollPosition ?? (a.preserveScrollPosition === undefined ? true : !a.preserveScrollPosition);
  return {
    type: 'NODE',
    navigation: a.navigation,
    destinationId: a.destinationId,
    resetScrollPosition: reset,
    preserveScrollPosition: a.preserveScrollPosition ?? !reset,
    // Unset is unchecked, as Figma's prototype panel shows it.
    resetInteractiveComponents: a.resetInteractiveComponents ?? false,
    overlayRelativePosition: a.overlayRelativePosition ? { x: a.overlayRelativePosition.x, y: a.overlayRelativePosition.y } : null,
  };
}

function action(a: Action): ProtoAction {
  switch (a.type) {
    case 'NODE':
      return nodeAction(a);
    case 'BACK':
    case 'CLOSE':
      return { type: a.type };
    case 'URL':
      return { type: 'URL', url: a.url };
    case 'UPDATE_MEDIA_RUNTIME':
      return { type: 'UPDATE_MEDIA_RUNTIME' };
    case 'SET_VARIABLE':
      return { type: 'SET_VARIABLE', variableId: a.variableId, value: a.variableValue ? expression(a.variableValue) : null };
    case 'SET_VARIABLE_MODE':
      return { type: 'SET_VARIABLE_MODE', collectionId: a.variableCollectionId, modeId: a.variableModeId };
    case 'CONDITIONAL':
      return {
        type: 'CONDITIONAL',
        blocks: a.conditionalBlocks.map((b) => ({ condition: b.condition ? expression(b.condition) : null, actions: b.actions.map(action) })),
      };
    default:
      return { type: 'UNKNOWN', rawType: (a as { type: string }).type };
  }
}

/** A layer's reactions; one without a trigger does nothing in the viewer and is left out. */
function reactionsOf(node: SceneNode): ProtoReaction[] {
  if (!('reactions' in node)) return [];
  const out: ProtoReaction[] = [];
  for (const r of (node as Reactive).reactions) {
    if (!r.trigger) continue;
    // Old files carry a single deprecated `action`.
    const actions = r.actions ?? (r.action ? [r.action] : []);
    out.push({ trigger: trigger(r.trigger), actions: actions.map(action) });
  }
  return out;
}

function background(b: OverlayBackground): ProtoBackground {
  return b.type === 'SOLID_COLOR' ? { type: 'SOLID_COLOR', color: rgba(b.color) } : { type: 'NONE' };
}

/** The explicit modes a frame is read in: its sections', outer to inner, then its own. */
function modesOf(node: Screen): Record<string, string> {
  const sections: SectionNode[] = [];
  for (let p = node.parent; p && p.type === 'SECTION'; p = p.parent) sections.unshift(p);
  const modes: Record<string, string> = {};
  for (const holder of [...sections, node]) Object.assign(modes, holder.explicitVariableModes);
  return modes;
}

function frameOf(node: Screen, pageId: string): ProtoFrame {
  return {
    id: node.id,
    name: node.name,
    pageId,
    width: node.width,
    height: node.height,
    overflowDirection: node.overflowDirection,
    numberOfFixedChildren: node.numberOfFixedChildren,
    overlay: {
      position: node.overlayPositionType,
      background: background(node.overlayBackground),
      closeOnOutsideClick: node.overlayBackgroundInteraction === 'CLOSE_ON_CLICK_OUTSIDE',
    },
    explicitVariableModes: modesOf(node),
  };
}

function variableValue(v: VariableValue): ProtoValue | null {
  if (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') return v;
  if ('type' in v && v.type === 'VARIABLE_ALIAS') return { alias: v.id };
  if (isColor(v)) return rgba(v);
  return null;
}

async function readVariables(api: PluginAPI): Promise<Record<string, ProtoCollection>> {
  const out: Record<string, ProtoCollection> = {};
  for (const c of await api.variables.getLocalVariableCollectionsAsync()) {
    const variables: Record<string, VariableDef> = {};
    for (const id of c.variableIds) {
      const v = await api.variables.getVariableByIdAsync(id);
      if (!v) throw new Error(`Variable ${id} of the collection ${c.name} can't be read`);
      // Easing and timing variables: no expression the engine evaluates can use them.
      if (!VARIABLE_TYPES.has(v.resolvedType)) continue;
      const valuesByMode: Record<string, ProtoValue> = {};
      for (const [modeId, value] of Object.entries(v.valuesByMode)) {
        const plain = variableValue(value);
        // A composed colour (a colour with a bound opacity) has no plain form the engine can evaluate.
        if (plain === null) throw new Error(`Variable ${v.name} has a value in mode ${modeId} the trace can't read`);
        valuesByMode[modeId] = plain;
      }
      variables[id] = { id, name: v.name, resolvedType: v.resolvedType as VariableType, valuesByMode };
    }
    out[c.id] = { id: c.id, name: c.name, modes: c.modes.map((m) => ({ modeId: m.modeId, name: m.name })), defaultModeId: c.defaultModeId, variables };
  }
  return out;
}

// --- Walking the flow ------------------------------------------------------------------

const hasReactions = (node: SceneNode): boolean => 'reactions' in node && (node as Reactive).reactions.length > 0;

/**
 * A screen's or a component's layers that have reactions, the node itself
 * first: one findAll, which walks the layers inside Figma, instead of a
 * walk here over every layer. It reaches hidden layers inside instances
 * while skipInvisibleInstanceChildren is off, as it is during a read.
 */
function reactive(node: SceneNode): SceneNode[] {
  const inside = 'findAll' in node ? node.findAll(hasReactions) : [];
  return hasReactions(node) ? [node, ...inside] : inside;
}

/** A layer's key inside a variant: its id without Figma's leading `I`. */
const pathOf = (node: BaseNode) => (node.id.startsWith('I') ? node.id.slice(1) : node.id);

function walkActions(actions: ProtoAction[], visit: (a: Extract<ProtoAction, { type: 'NODE' }>) => void): void {
  for (const a of actions) {
    if (a.type === 'NODE') visit(a);
    else if (a.type === 'CONDITIONAL') for (const block of a.blocks) walkActions(block.actions, visit);
  }
}

function nodeActions(reactions: ProtoReaction[]): Array<Extract<ProtoAction, { type: 'NODE' }>> {
  const out: Array<Extract<ProtoAction, { type: 'NODE' }>> = [];
  for (const r of reactions) walkActions(r.actions, (a) => out.push(a));
  return out;
}

function isTopLevelScreen(node: BaseNode): node is Screen {
  return (node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE') && topFrameOf(node) === node && !isScratch(node);
}

/** The variants an instance can show: those of its main component's set, or the main component alone. */
async function variantsAround(instance: InstanceNode): Promise<ComponentNode[]> {
  const main = await instance.getMainComponentAsync();
  if (!main) throw new Error(`The instance ${instance.id} has no main component, so its variants can't be read`);
  const set = main.parent;
  return set && set.type === 'COMPONENT_SET' ? (set.children as ComponentNode[]) : [main];
}

/** A component's layers with reactions, or why they can't be read (a library component whose layers the file doesn't hold). */
function layersOf(component: ComponentNode): SceneNode[] | Error {
  try {
    return reactive(component);
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

/** A read, with the frame each reaction key of `doc.reactions` is in, which the reader knows as it reads. */
export interface ProtoRead {
  doc: ProtoDoc;
  frameOf: Map<string, string>;
}

export async function readProto(api: PluginAPI, page: PageNode, options: ReadOptions): Promise<ProtoDoc> {
  return (await readProtoWithKeys(api, page, options)).doc;
}

export function readProtoWithKeys(api: PluginAPI, page: PageNode, options: ReadOptions): Promise<ProtoRead> {
  return exclusive(api, () => read(api, page, options));
}

async function read(api: PluginAPI, page: PageNode, options: ReadOptions): Promise<ProtoRead> {
  const frames: ProtoFrame[] = [];
  const reactions: Record<string, ProtoReaction[]> = {};
  const keyFrames = new Map<string, string>();
  const variantSets: Record<string, VariantSet> = {};
  const libraryVariants: LibraryVariant[] = [];
  const queue: Screen[] = [];
  const tried = new Set<string>();
  /** Reactions read since their destinations were last followed. */
  let unfollowed: ProtoReaction[] = [];

  const addFrame = (node: Screen, pageId: string) => {
    frames.push(frameOf(node, pageId));
    tried.add(node.id);
    queue.push(node);
  };
  for (const node of topLevelFrames(page)) if (isTopLevelScreen(node)) addFrame(node, page.id);

  /** Follows destinations to frames not read yet; a destination that doesn't exist is a broken link, left to the engine. */
  async function follow(): Promise<void> {
    const pending = unfollowed;
    unfollowed = [];
    for (const a of nodeActions(pending)) {
      if (a.navigation === 'SCROLL_TO' || a.navigation === 'CHANGE_TO' || a.destinationId === null || tried.has(a.destinationId)) continue;
      tried.add(a.destinationId);
      const dest = await api.getNodeByIdAsync(a.destinationId);
      if (!dest || dest.removed || !isTopLevelScreen(dest)) continue;
      const home = pageOf(dest);
      if (!home) throw new Error(`The frame ${dest.id} that a reaction leads to is on no page`);
      // With dynamic page access another page's layers load on demand.
      if (home.id !== page.id) await home.loadAsync();
      addFrame(dest, home.id);
    }
  }

  /**
   * Reads a variant's reactions by path. A library variant the file holds
   * is read in place, like a local one. One whose layers the file lacks is
   * imported when the read may (adding it to the file, as using it in
   * Figma would); it is unavailable otherwise, or when the import fails.
   */
  async function readVariant(variant: ComponentNode, instanceKey: string, frameId: string): Promise<ProtoVariant> {
    const unavailable: ProtoVariant = { id: variant.id, name: variant.name, reactions: {}, componentId: null, unavailable: true };
    let source: ComponentNode = variant;
    let layers = layersOf(variant);
    if (layers instanceof Error) {
      if (!variant.remote) throw layers;
      const listed = libraryVariants.find((l) => l.variantId === variant.id);
      const entry: LibraryVariant = listed ?? { variantId: variant.id, key: variant.key, name: variant.name, status: 'needs_import', error: null };
      if (!listed) libraryVariants.push(entry);
      if (!options.importLibraryVariants) return unavailable;
      try {
        source = await api.importComponentByKeyAsync(variant.key);
      } catch (err) {
        // The library isn't available to this file: CHANGE_TO to it is unsupported, and the panel says why.
        entry.status = 'failed';
        entry.error = String(err);
        return unavailable;
      }
      entry.status = 'imported';
      layers = layersOf(source);
      if (layers instanceof Error) throw layers;
    }
    const byPath: Record<string, ProtoReaction[]> = {};
    for (const node of layers) {
      const own = reactionsOf(node);
      if (!own.length) continue;
      byPath[node === source ? '' : pathOf(node)] = own;
      unfollowed.push(...own);
      await registerChangeTos(node, own, source, (n) => `${instanceKey};${pathOf(n)}`, frameId);
    }
    return { id: variant.id, name: variant.name, reactions: byPath, componentId: source.id, unavailable: false };
  }

  /**
   * For each CHANGE_TO among a layer's reactions, finds the instance it
   * changes (the nearest one at or above the layer, up to `top`, whose
   * variants hold the destination) and reads that instance's variants.
   * Inside a variant, `top` is the variant itself, a component: its own
   * CHANGE_TOs are the instance being read, already registered.
   */
  async function registerChangeTos(node: SceneNode, own: ProtoReaction[], top: SceneNode, keyOf: (n: SceneNode) => string, frameId: string) {
    for (const a of nodeActions(own)) {
      if (a.navigation !== 'CHANGE_TO' || a.destinationId === null) continue;
      for (let n: BaseNode | null = node; n && n !== top.parent; n = n.parent) {
        if (n.type !== 'INSTANCE') continue;
        const variants = await variantsAround(n as InstanceNode);
        if (!variants.some((v) => v.id === a.destinationId)) continue;
        const key = keyOf(n as SceneNode);
        if (!variantSets[key]) {
          const set: VariantSet = { frameId, variants: [] };
          variantSets[key] = set;
          for (const v of variants) set.variants.push(await readVariant(v, key, frameId));
        }
        break;
      }
    }
  }

  while (queue.length) {
    const frame = queue.shift() as Screen;
    for (const node of reactive(frame)) {
      const own = reactionsOf(node);
      if (!own.length) continue;
      reactions[node.id] = own;
      keyFrames.set(node.id, frame.id);
      unfollowed.push(...own);
      await registerChangeTos(node, own, frame, (n) => n.id, frame.id);
    }
    await follow();
  }

  const doc: Omit<ProtoDoc, 'docHash'> = {
    pageId: page.id,
    pageName: page.name,
    explicitVariableModes: { ...page.explicitVariableModes },
    frames,
    reactions,
    variantSets,
    variableCollections: await readVariables(api),
    libraryVariants,
  };
  return { doc: { docHash: hashText(stableJson(doc)), ...doc }, frameOf: keyFrames };
}
