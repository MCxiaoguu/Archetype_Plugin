/**
 * The flow map (spec, The flow map): the prototype as a state diagram.
 * Shared with the main thread, which reads the candidates: ES2017 only. Its
 * nodes are the ProtoDoc's frames and overlays, its edges the drawn
 * connections that change the screen, and its readings the backend's
 * reading of every unwired element a persona can click: an edge to a frame
 * the prototype has, a control, or a gap with no page behind it.
 *
 * The candidates the backend reads are the layers with no reaction of their
 * own that elements.ts lists as something to click. What is listed comes
 * from its role and label rules, so wiring never decides it.
 */

import { classifyElements } from './elements';
import { indexLayers, type LayerIndex } from './hitTest';
import type { ProtoAction, ProtoReaction, ProtoTrigger, RawLayer, RoleHint } from './model';

type TriggerType = ProtoTrigger['type'];

export interface FlowNode {
  id: string;
  /** An overlay is a frame a drawn reaction opens as an overlay. */
  kind: 'frame' | 'overlay';
  name: string;
  /** Its largest visible text, at most 120 characters; '' when it shows none. */
  heading: string;
  /** Its visible text in reading order, at most 1,500 characters. */
  text: string;
}

export interface FlowEdge {
  id: string;
  from: string;
  to: string;
  layerKey: string;
  label: string;
  trigger: TriggerType;
  by: 'designer';
}

export type CandidateRole = RoleHint;

/** A layer of a node with no reaction of its own that lists as something to click, for the backend to read. */
export interface FlowCandidate {
  node: string;
  layerKey: string;
  /**
   * One reading covers every candidate with the same share key: inside an
   * instance `C:<main component>;<path inside it>|<label, lowercased>`, so
   * an overridden text gets its own; otherwise `L:<node>:<layerKey>`.
   */
  shareKey: string;
  label: string;
  role: CandidateRole;
  /** In the node's coordinates, unscrolled: [x, y, width, height]. */
  box: [number, number, number, number];
  /** The visible text nearest to it, at most 200 characters. */
  nearText: string;
}

export type ReadingKind = 'edge' | 'control' | 'gap';

export interface FlowReading {
  id: string;
  node: string;
  layerKey: string;
  label: string;
  role: CandidateRole;
  kind: ReadingKind;
  /** The node an edge goes to; its own node means "already here". */
  to?: string;
  by: 'model' | 'designer';
  reason: string;
}

export interface FlowMap {
  version: number;
  docHash: string;
  nodes: Array<Omit<FlowNode, 'text'> & Partial<Pick<FlowNode, 'text'>>>;
  edges: FlowEdge[];
  readings: FlowReading[];
  completedAt: string;
  model: string | null;
}

export const MAX_HEADING = 120;
export const MAX_NODE_TEXT = 1500;
export const MAX_NEAR_TEXT = 200;
/** The most words a text layer can have and still read as a plain nav item rather than a paragraph. */
const MAX_LABEL_WORDS = 6;

const flat = (text: string) => text.replace(/\s+/g, ' ').trim();
const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).replace(/\s+$/, '')}…` : text);

/** A text layer that reads as a nav item: one line of at most six words. */
function readsAsLabel(layer: RawLayer): boolean {
  const text = (layer.text ?? '').trim();
  return !/[\n\r\u2028\u2029]/.test(text) && flat(text).split(' ').filter(Boolean).length <= MAX_LABEL_WORDS;
}

/** Inside an instance the label is part of the share key: instances of one component can show different texts. */
const shareKeyOf = (base: string, label: string) => (base.startsWith('C:') ? `${base}|${label.trim().toLowerCase()}` : base);

const CLICKABLE: ReadonlySet<RoleHint> = new Set<RoleHint>(['button', 'link', 'input', 'card', 'icon']);

const centre = (l: RawLayer) => ({ x: l.unclippedBox.x + l.unclippedBox.width / 2, y: l.unclippedBox.y + l.unclippedBox.height / 2 });

function inside(index: LayerIndex, key: string, ancestor: string): boolean {
  for (let k: string | null = key; k !== null; k = index.byKey.get(k)?.parentKey ?? null) if (k === ancestor) return true;
  return false;
}

/** The visible texts of measured layers, in reading order. */
export function visibleTexts(layers: RawLayer[], index: LayerIndex = indexLayers(layers)): RawLayer[] {
  return layers
    .filter((l) => l.type === 'TEXT' && index.visible.has(l.key) && flat(l.text ?? '') !== '')
    .sort((a, b) => a.unclippedBox.y - b.unclippedBox.y || a.unclippedBox.x - b.unclippedBox.x);
}

/**
 * The candidates of one node, from its measured layers (boxes in the node's
 * coordinates, unclipped). Hidden layers are listed as if shown, since a
 * variable or a variant may show them; nothing is cut by the viewport,
 * covered or capped. `shareOf` gives each layer's share key, before its label.
 */
export function candidatesOf(node: string, layers: RawLayer[], shareOf: (key: string) => string): FlowCandidate[] {
  const index = indexLayers(layers);
  const whole = layers.map((l) => ({ ...l, box: l.unclippedBox, visible: true }));
  const texts = visibleTexts(layers, index);
  const out: FlowCandidate[] = [];
  for (const { layer, role, label } of classifyElements(whole)) {
    const readable = label !== role && label !== 'unlabeled area';
    const listed = CLICKABLE.has(role) || (role === 'text' && readsAsLabel(layer)) || (role === 'image' && readable);
    if (!listed || layer.hasReactions) continue;
    const c = centre(layer);
    const near = texts
      .filter((t) => !inside(index, t.key, layer.key))
      .map((t) => ({ t, d: Math.hypot(centre(t).x - c.x, centre(t).y - c.y) }))
      .sort((a, b) => a.d - b.d)
      .map(({ t }) => flat(t.text ?? ''));
    const { x, y, width, height } = layer.unclippedBox;
    out.push({
      node,
      layerKey: layer.key,
      shareKey: shareKeyOf(shareOf(layer.key), label),
      label,
      role,
      box: [Math.round(x), Math.round(y), Math.round(width), Math.round(height)],
      nearText: cut(near.join(' · '), MAX_NEAR_TEXT),
    });
  }
  return out;
}

/** Every drawn connection that changes the screen: NAVIGATE, SWAP and OVERLAY to a set destination. */
export function edgeActions(reactions: ProtoReaction[]): Array<{ trigger: TriggerType; to: string; navigation: string }> {
  const out: Array<{ trigger: TriggerType; to: string; navigation: string }> = [];
  const walk = (trigger: TriggerType, actions: ProtoAction[]) => {
    for (const a of actions) {
      if (a.type === 'NODE' && a.destinationId !== null && (a.navigation === 'NAVIGATE' || a.navigation === 'SWAP' || a.navigation === 'OVERLAY')) {
        out.push({ trigger, to: a.destinationId, navigation: a.navigation });
      } else if (a.type === 'CONDITIONAL') {
        for (const block of a.blocks) walk(trigger, block.actions);
      }
    }
  };
  for (const r of reactions) walk(r.trigger.type, r.actions);
  return out;
}

export { cut as cutText, flat as flatText };
