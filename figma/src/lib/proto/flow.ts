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
import type { ProtoAction, ProtoReaction, ProtoTrigger, RawLayer, ReadingLookup, RoleHint } from './model';

type TriggerType = ProtoTrigger['type'];

export interface FlowNode {
  id: string;
  /** An overlay is a frame every drawn edge into it opens as an overlay. */
  kind: 'frame' | 'overlay';
  name: string;
  /** The page the frame is on. */
  pageId: string;
  /** Its largest visible text, at most 120 characters; '' when it shows none. */
  heading: string;
  /** Its visible text in reading order, at most 1,500 characters. */
  text: string;
}

export type EdgeAction = 'NAVIGATE' | 'SWAP' | 'OVERLAY' | 'SCROLL_TO';

/** A drawn NODE action with a destination. */
export interface FlowEdge {
  id: string;
  from: string;
  /** The frame it shows; for SCROLL_TO, the layer it scrolls to. */
  to: string;
  layerKey: string;
  label: string;
  trigger: TriggerType;
  action: EdgeAction;
  /** Inside a variant, or a CONDITIONAL branch: it fires only in some states. */
  conditional: boolean;
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

/**
 * The backend's reading of one share key, in one version of the study's
 * flow map: every place its candidates appear, `nodes[i]` with `layerKeys[i]`.
 */
export interface FlowReading {
  /** Stable across versions: `r1`, `r2` and so on. */
  id: string;
  shareKey: string;
  nodes: string[];
  layerKeys: string[];
  label: string;
  role: CandidateRole;
  kind: ReadingKind;
  /** The frame an edge goes to (the screen's own frame means "already here"); null for a control or a gap. */
  to: string | null;
  /** `bulk_gap`: launched with drawn connections only, and read again by the next build. */
  by: 'model' | 'designer' | 'bulk_gap';
  reason: string;
}

/** One immutable version of a study's flow map, as the backend stores it. */
export interface FlowMap {
  studyId: string;
  version: number;
  /** Null for version 1. */
  baseVersion: number | null;
  inputHash: string;
  docHash: string;
  nodes: Array<Omit<FlowNode, 'text'>>;
  edges: FlowEdge[];
  readings: FlowReading[];
  /** The designer's readings a build couldn't carry over: their frame or their element is gone. */
  dropped: Array<{ id: string; shareKey: string; label: string; reason: string }>;
  completedAt: string;
  /** Null when no model read anything in this version. */
  model: string | null;
  /** The build that wrote it; null for an edit or a drawn connections only version. */
  buildId: string | null;
}

/** A map's readings by each place they are of, for the engine (model.ts ReadingLookup), and by id. */
export function readingLookup(map: FlowMap): { lookup: ReadingLookup; byId: Map<string, FlowReading> } {
  const byPlace = new Map<string, FlowReading>();
  const byId = new Map<string, FlowReading>();
  for (const r of map.readings) {
    if (r.nodes.length !== r.layerKeys.length) throw new Error(`Flow map version ${map.version}'s reading ${r.id} has ${r.nodes.length} nodes for ${r.layerKeys.length} layers`);
    r.nodes.forEach((node, i) => byPlace.set(`${node} ${r.layerKeys[i] as string}`, r));
    byId.set(r.id, r);
  }
  const lookup: ReadingLookup = (node, layerKey) => {
    const r = byPlace.get(`${node} ${layerKey}`);
    return r ? { id: r.id, kind: r.kind, to: r.to } : null;
  };
  return { lookup, byId };
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

/**
 * Whether an element lists as a flow map candidate: no reaction of its own,
 * and something to click by its role (button, link, input, card, icon), an
 * image with a readable name, or a text that reads as a nav item.
 */
export function isCandidate(layer: RawLayer, role: RoleHint, label: string): boolean {
  if (layer.hasReactions) return false;
  const readable = label !== role && label !== 'unlabeled area';
  return CLICKABLE.has(role) || (role === 'text' && readsAsLabel(layer)) || (role === 'image' && readable);
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
    if (!isCandidate(layer, role, label)) continue;
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

const EDGE_ACTIONS: ReadonlySet<string> = new Set<EdgeAction>(['NAVIGATE', 'SWAP', 'OVERLAY', 'SCROLL_TO']);

/** Every drawn NODE action with a destination (CHANGE_TO is a variant's, not an edge), those in CONDITIONAL branches marked. */
export function edgeActions(reactions: ProtoReaction[]): Array<{ trigger: TriggerType; to: string; action: EdgeAction; conditional: boolean }> {
  const out: Array<{ trigger: TriggerType; to: string; action: EdgeAction; conditional: boolean }> = [];
  const walk = (trigger: TriggerType, actions: ProtoAction[], conditional: boolean) => {
    for (const a of actions) {
      if (a.type === 'NODE' && a.destinationId !== null && EDGE_ACTIONS.has(a.navigation)) {
        out.push({ trigger, to: a.destinationId, action: a.navigation as EdgeAction, conditional });
      } else if (a.type === 'CONDITIONAL') {
        for (const block of a.blocks) walk(trigger, block.actions, true);
      }
    }
  };
  for (const r of reactions) walk(r.trigger.type, r.actions, false);
  return out;
}

export { cut as cutText, flat as flatText };
