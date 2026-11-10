/**
 * What the persona sees: the measured layers turned into a short list of
 * elements, `{id, label, role, box}`, in reading order. Listed are text
 * blocks, instances, and frames or shapes that look actionable, wired or
 * not, inside the viewport. Layers that carry reactions but draw nothing
 * (hotspots over screenshots) are listed as "unlabeled area"; nothing else
 * of the wiring shows. Labels are the text inside a layer or a readable
 * layer name, never a generic one like "Rectangle 12".
 */

import { indexLayers, type LayerIndex } from './hitTest';
import type { Box, Element, ElementBox, ElementTarget, RawLayer, RoleHint, TraceState } from './model';

export const MAX_ELEMENTS = 80;
const MAX_LABEL = 120;

/** Figma's default layer names, and the names of exported images and icons. */
const DEFAULT_NAME =
  /^(rectangle|ellipse|frame|group|vector|line|polygon|star|image|text|component|instance|union|subtract|intersect|exclude|section|slice|arrow|mask group|shape|layer|icon|photo|picture|img|screenshot|screen shot)( ?\d+)*$/i;
const ASSET_NAME = /^(icons8|ic_|img_|pexels|unsplash|shutterstock|istock|adobestock)/i;
const FILE_NAME = /\.(png|jpe?g|gif|svg|webp|heic|pdf)$/i;
/** Names of layers that are controls whatever they draw. */
const CONTROL_NAME = /\b(button|btn|cta|link|tab|input|field|search|checkbox|radio|toggle|switch|dropdown|select|menu|chip)\b/i;

export function isGenericName(name: string): boolean {
  const n = name.trim();
  return (
    !/[a-z]/i.test(n) ||
    DEFAULT_NAME.test(n) ||
    ASSET_NAME.test(n) ||
    FILE_NAME.test(n) ||
    // Variant properties ("State=Default") and long numbers ("IMG_2034") aren't words.
    n.includes('=') ||
    /\d{4,}/.test(n)
  );
}

/** A layer name a person could read, or null: the last part of a slash path, with dashes and underscores as spaces. */
export function readableName(name: string): string | null {
  const last = (name.split('/').pop() ?? '').trim();
  if (!last || isGenericName(last) || isGenericName(name)) return null;
  return last.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function cleanText(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_LABEL ? `${flat.slice(0, MAX_LABEL - 1).trimEnd()}…` : flat;
}

function intersect(a: Box, b: Box): Box | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

const within = (inner: Box, outer: Box) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

const isText = (layer: RawLayer) => layer.type === 'TEXT' && (layer.text ?? '').trim() !== '';

interface Candidate {
  layer: RawLayer;
  /** The part of its box inside the viewport. */
  view: Box;
  /** Its place in paint order, which breaks reading order ties. */
  order: number;
  role: RoleHint;
  label: string;
}

/** Depth below the frame root, so a layer is decided after everything inside it. */
function depthOf(index: LayerIndex, layer: RawLayer): number {
  let depth = 0;
  for (let l = layer; l.parentKey !== null; l = index.byKey.get(l.parentKey) as RawLayer) depth++;
  return depth;
}

/** The texts a control owns: those inside it with no other control between. */
function ownTexts(index: LayerIndex, texts: RawLayer[], controls: Set<string>, key: string): RawLayer[] {
  return texts.filter((t) => {
    for (let p = t.parentKey; p !== null; p = (index.byKey.get(p) as RawLayer).parentKey) {
      if (p === key) return true;
      if (controls.has(p)) return false;
    }
    return false;
  });
}

const readingOrder = (a: Candidate, b: Candidate) => a.view.y - b.view.y || a.view.x - b.view.x || a.order - b.order;

/** Whether a later frame on screen (an overlay over the layer's frame) covers the layer. */
function covered(index: LayerIndex, s: TraceState, layer: RawLayer, view: Box): boolean {
  const frames = [s.frameId, ...s.overlays.map((o) => o.frameId)];
  const own = frames.indexOf(index.rootOf.get(layer.key) as string);
  return frames.slice(own + 1).some((id) => {
    const top = index.byKey.get(id);
    return top !== undefined && within(view, top.box);
  });
}

/** The trimmed list: text blocks go first, the smallest first, then the smallest elements of any kind. */
function capped(candidates: Candidate[]): Candidate[] {
  const area = (c: Candidate) => c.view.width * c.view.height;
  const smallestFirst = (a: Candidate, b: Candidate) => area(a) - area(b) || readingOrder(b, a);
  const dropped = new Set<Candidate>();
  const excess = () => candidates.length - dropped.size - MAX_ELEMENTS;
  for (const c of candidates.filter((c) => c.role === 'text').sort(smallestFirst)) {
    if (excess() <= 0) break;
    dropped.add(c);
  }
  for (const c of candidates.filter((c) => !dropped.has(c)).sort(smallestFirst)) {
    if (excess() <= 0) break;
    dropped.add(c);
  }
  return candidates.filter((c) => !dropped.has(c));
}

export function listElements(layers: RawLayer[], s: TraceState): { elements: Element[]; targets: Record<string, ElementTarget> } {
  const index = indexLayers(layers);
  const viewport: Box = { x: 0, y: 0, width: s.viewport.width, height: s.viewport.height };
  const shown = layers.filter((l) => index.visible.has(l.key));
  const texts = shown.filter(isText);

  // Decide the controls from the innermost out, so a frame knows which texts are its own.
  const controls = new Set<string>();
  const others = shown.filter((l) => l.parentKey !== null && l.type !== 'TEXT');
  for (const layer of [...others].sort((a, b) => depthOf(index, b) - depthOf(index, a))) {
    const framed = layer.paints && (CONTROL_NAME.test(layer.name) || ownTexts(index, texts, controls, layer.key).length === 1);
    const hinted = layer.roleHint !== null && layer.roleHint !== 'text';
    if (layer.type === 'INSTANCE' || layer.hasReactions || hinted || framed) controls.add(layer.key);
  }

  const consumed = new Set<string>();
  const candidates: Candidate[] = [];
  const add = (layer: RawLayer, role: RoleHint, label: string) => {
    const view = intersect(layer.box, viewport);
    if (view && !covered(index, s, layer, view)) candidates.push({ layer, view, order: layers.indexOf(layer), role, label });
  };

  for (const layer of others.filter((l) => controls.has(l.key))) {
    const own = ownTexts(index, texts, controls, layer.key).sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
    const role: RoleHint =
      layer.roleHint !== null && layer.roleHint !== 'text' ? layer.roleHint : layer.type === 'INSTANCE' && own.length > 1 ? 'card' : 'button';
    // A control with one text is labelled by it, which then isn't listed on its own.
    if (own.length === 1) consumed.add((own[0] as RawLayer).key);
    const first = own[0];
    const fallback = layer.hasReactions && !layer.paints ? 'unlabeled area' : role;
    add(layer, role, first ? cleanText(first.text ?? '') : (readableName(layer.name) ?? fallback));
  }
  for (const layer of texts) {
    if (consumed.has(layer.key)) continue;
    add(layer, layer.hasReactions || layer.roleHint === 'link' ? 'link' : 'text', cleanText(layer.text ?? ''));
  }

  const elements: Element[] = [];
  const targets: Record<string, ElementTarget> = {};
  capped(candidates)
    .sort(readingOrder)
    .forEach((c, i) => {
      const id = `e${i + 1}`;
      const { x, y, width, height } = c.view;
      const elementBox: ElementBox = [Math.round(x), Math.round(y), Math.round(width), Math.round(height)];
      elements.push({ id, label: c.label, role: c.role, box: elementBox });
      targets[id] = { layerKey: c.layer.key, point: { x: x + width / 2, y: y + height / 2 } };
    });
  return { elements, targets };
}
