/**
 * What a layer is and where, as the renderer measures its copies and the
 * flow map reads the original nodes: its box against an origin, whether it
 * draws anything of its own, and the role its looks suggest.
 */

import type { Box, RoleHint } from '../lib/proto/model';

const VECTOR_TYPES: ReadonlySet<string> = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON']);
const INPUT_NAME = /\b(input|field|text ?box|search ?bar)\b/i;
const CONTROL_NAME = /\b(button|btn|cta|toggle|switch|checkbox|radio)\b/i;
const CARD_NAME = /\bcard\b/i;
/** The largest box an unlabelled shape can have and still read as an icon. */
const ICON_SIZE = 48;

export function* subtree(node: SceneNode): Generator<SceneNode> {
  yield node;
  if ('children' in node) for (const child of node.children) yield* subtree(child);
}

/** Fixed children are the last `numberOfFixedChildren` of a frame: Figma draws them over the scrolling ones. */
export function fixedChildren(node: SceneNode): Set<SceneNode> {
  if (!('numberOfFixedChildren' in node) || !node.numberOfFixedChildren) return new Set();
  const kids = (node as FrameNode).children;
  return new Set(kids.slice(kids.length - node.numberOfFixedChildren));
}

export function boxIn(node: SceneNode, origin: Rect): Box {
  const abs = node.absoluteBoundingBox;
  if (!abs) throw new Error(`The layer ${node.id} has no box`);
  return { x: abs.x - origin.x, y: abs.y - origin.y, width: abs.width, height: abs.height };
}

export function intersect(a: Box, b: Box): Box | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

const visiblePaint = (paints: unknown) => Array.isArray(paints) && paints.some((p: Paint) => p.visible !== false && (p.opacity ?? 1) > 0);

/** Whether a layer draws anything of its own: a visible fill, stroke or effect, or text. */
export function paintsOf(node: SceneNode): boolean {
  if ('opacity' in node && node.opacity === 0) return false;
  if (node.type === 'TEXT') return node.characters.trim() !== '';
  if ('fills' in node && visiblePaint(node.fills)) return true;
  // A stroke of mixed weights (figma.mixed) has some side drawn.
  if ('strokes' in node && visiblePaint(node.strokes) && (typeof node.strokeWeight !== 'number' || node.strokeWeight > 0)) return true;
  return 'effects' in node && node.effects.some((e) => e.visible);
}

const hasText = (node: SceneNode) => [...subtree(node)].some((n) => n.type === 'TEXT');

export function roleHintOf(node: SceneNode): RoleHint | null {
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

