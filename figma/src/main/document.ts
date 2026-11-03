import { genericNameReason } from '../lib/names';
import type { DestinationInfo, DocSnapshot, FrameInfo, HotspotAction, HotspotInfo, NavigationKind, NodeRef } from '../lib/types';

/** More interactive layers than this on one page are cut off (and flagged). */
export const MAX_HOTSPOTS = 4000;

type Container = BaseNode & ChildrenMixin;

function isContainerNode(n: BaseNode): n is Container {
  return 'children' in n;
}

/** Nodes that can be a screen in a prototype: frames and their relatives. */
function isScreenNode(n: SceneNode): boolean {
  return n.type === 'FRAME' || n.type === 'COMPONENT' || n.type === 'INSTANCE' || n.type === 'COMPONENT_SET';
}

/**
 * Top level frames: direct children of the page, and frames inside sections
 * (sections can nest), which Figma also treats as prototype screens.
 */
export function topLevelFrames(page: PageNode): SceneNode[] {
  const out: SceneNode[] = [];
  const walk = (parent: Container) => {
    for (const child of parent.children as readonly SceneNode[]) {
      if (child.type === 'SECTION') walk(child);
      else if (isScreenNode(child)) out.push(child);
    }
  };
  walk(page);
  return out;
}

/** The top level frame that contains `node` (the node itself when it is one). */
export function topFrameOf(node: BaseNode): SceneNode | null {
  let cur: BaseNode | null = node;
  while (cur && cur.parent) {
    const parent: BaseNode = cur.parent;
    if (parent.type === 'PAGE' || parent.type === 'SECTION') {
      return isScreenNode(cur as SceneNode) ? (cur as SceneNode) : null;
    }
    cur = parent;
  }
  return null;
}

export function pageOf(node: BaseNode): PageNode | null {
  let cur: BaseNode | null = node;
  while (cur) {
    if (cur.type === 'PAGE') return cur as PageNode;
    cur = cur.parent;
  }
  return null;
}

function flattenActions(actions: ReadonlyArray<Action>, out: HotspotAction[]): void {
  for (const a of actions) {
    switch (a.type) {
      case 'NODE':
        out.push({ kind: 'node', navigation: a.navigation as NavigationKind, destinationId: a.destinationId ?? null });
        break;
      case 'BACK':
        out.push({ kind: 'back' });
        break;
      case 'CLOSE':
        out.push({ kind: 'close' });
        break;
      case 'URL':
        out.push({ kind: 'url', url: a.url });
        break;
      case 'CONDITIONAL':
        for (const block of a.conditionalBlocks ?? []) flattenActions(block.actions ?? [], out);
        break;
      default:
        out.push({ kind: 'other', type: a.type });
    }
  }
}

export function reactionActions(reactions: ReadonlyArray<Reaction>): HotspotAction[] {
  const out: HotspotAction[] = [];
  for (const r of reactions) {
    const list = r.actions && r.actions.length ? r.actions : r.action ? [r.action] : [];
    flattenActions(list, out);
  }
  return out;
}

function firstText(node: SceneNode): string | null {
  if (node.type === 'TEXT') return node.characters;
  if (!isContainerNode(node)) return null;
  const t = (node as unknown as ChildrenMixin).findOne((n) => n.type === 'TEXT') as TextNode | null;
  return t ? t.characters : null;
}

function hasReactions(n: SceneNode): boolean {
  return 'reactions' in n && Array.isArray((n as SceneNode & ReactionMixin).reactions) && (n as SceneNode & ReactionMixin).reactions.length > 0;
}

export async function readDocument(api: PluginAPI): Promise<DocSnapshot> {
  const page = api.currentPage;
  const frameNodes = topLevelFrames(page);
  const frames: FrameInfo[] = frameNodes.map((f) => {
    const info: FrameInfo = { id: f.id, name: f.name };
    if ('overlayBackgroundInteraction' in f && f.overlayBackgroundInteraction === 'CLOSE_ON_CLICK_OUTSIDE') {
      info.closesOnOutsideClick = true;
    }
    return info;
  });
  const frameIds = new Set(frames.map((f) => f.id));

  const hotspots: HotspotInfo[] = [];
  let truncated = false;
  const reactive = page.findAll((n) => hasReactions(n));
  for (const node of reactive) {
    if (hotspots.length >= MAX_HOTSPOTS) {
      truncated = true;
      break;
    }
    const top = topFrameOf(node);
    if (!top || !frameIds.has(top.id)) continue;
    const reactions = (node as SceneNode & ReactionMixin).reactions;
    const trigger = reactions[0]?.trigger?.type ?? 'NONE';
    const h: HotspotInfo = { id: node.id, name: node.name, type: node.type, frameId: top.id, trigger, actions: reactionActions(reactions) };
    if (node.id !== top.id && genericNameReason(node.name)) h.textHint = firstText(node);
    hotspots.push(h);
  }

  const destinations: Record<string, DestinationInfo> = {};
  const destIds = new Set<string>();
  for (const h of hotspots) for (const a of h.actions) if (a.kind === 'node' && a.destinationId) destIds.add(a.destinationId);
  for (const id of destIds) {
    let node: BaseNode | null = null;
    try {
      node = await api.getNodeByIdAsync(id);
    } catch {
      node = null;
    }
    if (!node || ('removed' in node && node.removed)) {
      destinations[id] = { exists: false, frameId: null };
      continue;
    }
    const top = topFrameOf(node);
    destinations[id] = { exists: true, frameId: top && frameIds.has(top.id) ? top.id : null };
  }

  return {
    fileName: api.root.name || 'Prototype',
    pageId: page.id,
    pageName: page.name,
    frames,
    flowStarts: page.flowStartingPoints.map((f) => ({ nodeId: f.nodeId, name: f.name })),
    hotspots,
    destinations,
    truncated,
  };
}

/** The frame a selection points at: a selected frame, or the frame around a selected layer. */
export function selectedFrame(api: PluginAPI): NodeRef | null {
  const sel = api.currentPage.selection;
  if (sel.length !== 1) return null;
  const top = topFrameOf(sel[0] as SceneNode);
  return top ? { id: top.id, name: top.name } : null;
}
