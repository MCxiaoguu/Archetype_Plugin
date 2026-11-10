/**
 * The flow map's main thread half (spec, At launch: the panel): every
 * node's candidates and the drawn edges, read from the original nodes
 * without rendering anything.
 *
 * Candidates are keyed as the renderer keys the layers it measures, so the
 * engine finds a candidate's reading under the layer an element names: a
 * frame's own layers by their ids (inside an instance showing its main
 * component, Figma's `I<instance>;<path>`), and the layers of each variant
 * an interactive component can show by `<instance key>;<path>`, as once
 * that variant is swapped in. Their share keys name the same layer of a
 * main component wherever an instance of it is placed.
 */

import { classifyElements, readableName } from '../lib/proto/elements';
import {
  candidatesOf,
  cutText,
  edgeActions,
  flatText,
  MAX_HEADING,
  MAX_NODE_TEXT,
  visibleTexts,
  type FlowCandidate,
  type FlowEdge,
  type FlowNode,
} from '../lib/proto/flow';
import type { Box, ProtoDoc, RawLayer, TraceState } from '../lib/proto/model';
import { isInside, reactionsFor } from '../lib/proto/variants';
import type { FlowRead } from '../lib/messages';
import { pageOf } from './document';
import { boxIn, paintsOf, roleHintOf } from './measure';

type Screen = FrameNode | ComponentNode | InstanceNode;

const isScreen = (node: BaseNode | null): node is Screen => !!node && (node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE');

/** A layer's key inside a variant: its id without Figma's leading `I` (as the reader keys a variant's reactions). */
const pathOf = (node: BaseNode) => (node.id.startsWith('I') ? node.id.slice(1) : node.id);

/** A text's font size: its own, or the largest of its runs when they differ. */
function fontSizeOf(node: TextNode): number {
  if (typeof node.fontSize === 'number') return node.fontSize;
  return Math.max(...node.getStyledTextSegments(['fontSize']).map((s) => s.fontSize));
}

interface Measured {
  layers: RawLayer[];
  /** The font size of each text layer, by key, for the node's heading. */
  sizes: Map<string, number>;
  /** The share key of each layer, by key (FlowCandidate.shareKey). */
  shares: Map<string, string>;
}

const measured = (): Measured => ({ layers: [], sizes: new Map(), shares: new Map() });

/**
 * How a subtree's layers are keyed: `keyOf` gives a layer's key, and
 * `shareOf` its share key, given the main component of the outermost
 * instance it is inside when `byInstance` (null outside one).
 */
interface Keying {
  byInstance: boolean;
  keyOf(node: SceneNode): string;
  shareOf(node: SceneNode, key: string, outer: { instance: InstanceNode; mainId: string } | null): string;
}

/**
 * An original subtree as measured layers: boxes in the node's coordinates
 * (against `origin`, moved by `shift`), never clipped.
 */
async function measureOriginal(
  root: SceneNode,
  keying: Keying,
  origin: Rect,
  shift: { x: number; y: number },
  parentKey: string | null,
  reactive: (key: string) => boolean,
  into: Measured,
): Promise<void> {
  const walk = async (node: SceneNode, parent: string | null, outer: { instance: InstanceNode; mainId: string } | null) => {
    const key = keying.keyOf(node);
    const own = boxIn(node, origin);
    const box: Box = { x: own.x + shift.x, y: own.y + shift.y, width: own.width, height: own.height };
    into.layers.push({
      key,
      type: node.type,
      name: node.name,
      text: node.type === 'TEXT' ? node.characters : null,
      box,
      unclippedBox: box,
      visible: node.visible,
      paints: paintsOf(node),
      hasReactions: reactive(key),
      roleHint: roleHintOf(node),
      parentKey: parent,
      scroll: null,
      fixed: false,
    });
    into.shares.set(key, keying.shareOf(node, key, outer));
    if (node.type === 'TEXT') into.sizes.set(key, fontSizeOf(node));
    let inner = outer;
    if (keying.byInstance && !inner && node.type === 'INSTANCE') {
      const main = await node.getMainComponentAsync();
      if (!main) throw new Error(`The instance ${node.name} (${node.id}) has no main component`);
      inner = { instance: node, mainId: main.id };
    }
    if ('children' in node) for (const child of node.children) await walk(child, key, inner);
  };
  await walk(root, parentKey, null);
}

/** The variant overrides of the node under which reactions apply (variants.reactionsFor reads no more of a state). */
function stateWith(frameId: string, overrides: Record<string, string>): Pick<TraceState, 'variants'> {
  return { variants: Object.keys(overrides).length ? { [frameId]: { ...overrides } } : {} };
}

/** A state of a frame's interactive components: its layers, their share keys, and the overrides that show it. */
interface Scene {
  scene: RawLayer[];
  shares: Map<string, string>;
  overrides: Record<string, string>;
}

/** Where an interactive component sits: a scene that shows it, and its layer there. */
interface Placement {
  at: Scene;
  layer: RawLayer;
}

/** The layers of `scene` with the instance `key` and everything inside it left out. */
const without = (scene: RawLayer[], key: string) => scene.filter((l) => l.key !== key && !isInside(key, l.key));

/** The label a layer goes by: as it lists, or its readable name or text. */
function labelOf(scene: RawLayer[], key: string): string {
  const listed = classifyElements(scene).find((c) => c.layer.key === key);
  if (listed) return listed.label;
  const layer = scene.find((l) => l.key === key);
  if (!layer) return key;
  return readableName(layer.name) ?? (flatText(layer.text ?? '') || key);
}

/** The node's heading: its largest visible text, the first in reading order among the largest. */
function headingOf(m: Measured): string {
  let best: RawLayer | null = null;
  for (const t of visibleTexts(m.layers)) if (!best || (m.sizes.get(t.key) as number) > (m.sizes.get(best.key) as number)) best = t;
  return best ? cutText(flatText(best.text ?? ''), MAX_HEADING) : '';
}

/**
 * Reads the flow of `doc`: its nodes, drawn edges and candidates.
 * `frameOf` is the frame each reaction key is in, as the read found it.
 * Run in the queue of reads and renders (scratch.exclusive).
 */
export async function readFlow(api: PluginAPI, doc: ProtoDoc, frameOf: ReadonlyMap<string, string>): Promise<FlowRead> {
  const nodes: FlowNode[] = [];
  const candidates: FlowCandidate[] = [];
  const scenes = new Map<string, Scene[]>();

  for (const frame of doc.frames) {
    const original = await api.getNodeByIdAsync(frame.id);
    if (!isScreen(original) || original.removed) throw new Error(`The frame ${frame.name} (${frame.id}) isn't in the file any more`);
    const page = pageOf(original);
    if (!page) throw new Error(`The frame ${frame.name} (${frame.id}) is on no page`);
    if (page !== api.currentPage) await page.loadAsync();
    const origin = original.absoluteBoundingBox as Rect;
    const base = stateWith(frame.id, {});
    const frameKeying: Keying = {
      byInstance: true,
      keyOf: (n) => n.id,
      // Inside an instance a layer's id is `I<outermost instance>;<its path inside the main component>`.
      shareOf: (n, key, outer) => (outer ? `C:${outer.mainId};${key.slice(outer.instance.id.length + 2)}` : `L:${frame.id}:${key}`),
    };
    const own = measured();
    await measureOriginal(original, frameKeying, origin, { x: 0, y: 0 }, null, (key) => reactionsFor(doc, base, key).length > 0, own);
    const heading = headingOf(own);
    const text = cutText(visibleTexts(own.layers).map((t) => flatText(t.text ?? '')).join(' · '), MAX_NODE_TEXT);
    nodes.push({ id: frame.id, kind: 'frame', name: frame.name, heading, text });

    const listed = new Set<string>();
    const add = (list: FlowCandidate[]) => {
      for (const c of list) {
        if (listed.has(c.layerKey)) continue;
        listed.add(c.layerKey);
        candidates.push(c);
      }
    };
    add(candidatesOf(frame.id, own.layers, (key) => own.shares.get(key) as string));
    const frameScenes: Scene[] = [{ scene: own.layers, shares: own.shares, overrides: {} }];

    // Each variant an interactive component in the frame can show; outer components before those inside them.
    const sets = Object.entries(doc.variantSets).filter(([, set]) => set.frameId === frame.id).sort(([a], [b]) => a.length - b.length);
    for (const [instanceKey, set] of sets) {
      const placement = frameScenes
        .map((at): Placement | null => {
          const layer = at.scene.find((l) => l.key === instanceKey);
          return layer ? { at, layer } : null;
        })
        .find((p): p is Placement => p !== null);
      // An instance shown in no state the flow reaches has nothing a persona could click.
      if (!placement) continue;
      for (const variant of set.variants) {
        if (!variant.componentId) continue;
        const componentId = variant.componentId;
        const component = await api.getNodeByIdAsync(componentId);
        if (!component || component.type !== 'COMPONENT') throw new Error(`The variant ${variant.name} (${componentId}) isn't in the file any more`);
        const overrides = { ...placement.at.overrides, [instanceKey]: variant.id };
        const s = stateWith(frame.id, overrides);
        const shown = measured();
        const variantKeying: Keying = {
          byInstance: false,
          keyOf: (n) => (n === component ? instanceKey : `${instanceKey};${pathOf(n)}`),
          // The variant is the main component its swapped layers are inside.
          shareOf: (n) => `C:${componentId};${pathOf(n)}`,
        };
        await measureOriginal(
          component,
          variantKeying,
          component.absoluteBoundingBox as Rect,
          { x: placement.layer.unclippedBox.x, y: placement.layer.unclippedBox.y },
          placement.layer.parentKey,
          (key) => reactionsFor(doc, s, key).length > 0,
          shown,
        );
        // The root is the instance itself, showing the variant.
        const root = shown.layers[0] as RawLayer;
        root.type = 'INSTANCE';
        root.name = placement.layer.name;
        root.visible = placement.layer.visible;
        shown.shares.set(instanceKey, placement.at.shares.get(instanceKey) as string);
        const scene = [...without(placement.at.scene, instanceKey), ...shown.layers];
        add(candidatesOf(frame.id, scene, (key) => shown.shares.get(key) as string).filter((c) => c.layerKey === instanceKey || isInside(instanceKey, c.layerKey)));
        frameScenes.push({ scene, shares: new Map([...placement.at.shares, ...shown.shares]), overrides });
      }
    }
    scenes.set(frame.id, frameScenes);
  }

  // The drawn edges: of the frames' own layers, then of the variants', in the order the doc lists them.
  const edges: FlowEdge[] = [];
  const incoming = new Map<string, string[]>();
  const addEdges = (from: string, layerKey: string, reactions: Parameters<typeof edgeActions>[0], scene: RawLayer[]) => {
    for (const e of edgeActions(reactions)) {
      edges.push({ id: `d${edges.length + 1}`, from, to: e.to, layerKey, label: labelOf(scene, layerKey), trigger: e.trigger, by: 'designer' });
      incoming.set(e.to, [...(incoming.get(e.to) ?? []), e.navigation]);
    }
  };
  for (const [key, reactions] of Object.entries(doc.reactions)) {
    const from = frameOf.get(key);
    if (from === undefined) throw new Error(`The read of the prototype left out which frame its layer ${key} is in`);
    const frameScenes = scenes.get(from);
    if (!frameScenes) throw new Error(`The layer ${key} is in ${from}, which isn't one of the prototype's frames`);
    addEdges(from, key, reactions, (frameScenes[0] as Scene).scene);
  }
  for (const [instanceKey, set] of Object.entries(doc.variantSets)) {
    for (const variant of set.variants) {
      // A variant no state shows (or one that couldn't be imported) has no connection a persona can take.
      const shown = (scenes.get(set.frameId) as Scene[]).find((f) => f.overrides[instanceKey] === variant.id);
      if (!shown) continue;
      for (const [path, reactions] of Object.entries(variant.reactions)) {
        addEdges(set.frameId, path === '' ? instanceKey : `${instanceKey};${path}`, reactions, shown.scene);
      }
    }
  }
  // An overlay is a frame reached only as an overlay.
  for (const node of nodes) {
    const ways = incoming.get(node.id);
    if (ways && ways.every((w) => w === 'OVERLAY')) node.kind = 'overlay';
  }
  return { docHash: doc.docHash, nodes, edges, candidates };
}
