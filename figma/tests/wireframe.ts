/**
 * A real picture for the fake file's export, for the live trace run: the
 * fake's `exportAsync` gives JSON, but a live model must see an image.
 * `sceneOf` reads what the exported node's tree draws, at export time, as
 * the renderer measured it: every box from `absoluteBoundingBox`, clipped
 * to the ancestors that clip their content, in paint order.
 * harness/wireframe.py (started by harness/live.mjs) draws the scene as a
 * JPEG: fills and strokes as boxes, text in place, image fills as grey
 * placeholders. Test harness only; the plugin exports through Figma.
 */

import type { Box } from '../src/lib/proto/model';
import type { FakeNode } from './fake-figma';

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export type WireOp =
  | { kind: 'fill'; key: string; box: Box; clip: Box; opacity: number; color: Rgba; round: boolean }
  | { kind: 'image'; key: string; box: Box; clip: Box; opacity: number }
  | { kind: 'stroke'; key: string; box: Box; clip: Box; opacity: number; color: Rgba; weight: number; round: boolean }
  | { kind: 'text'; key: string; box: Box; clip: Box; opacity: number; color: Rgba; text: string; size: number };

export interface Scene {
  width: number;
  height: number;
  ops: WireOp[];
}

/** Layers that draw only their children: a group has no paint of its own. */
const NO_PAINT: ReadonlySet<string> = new Set(['GROUP', 'SECTION', 'BOOLEAN_OPERATION']);

function intersect(a: Box, b: Box): Box | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

interface FakePaint {
  type: string;
  visible?: boolean;
  opacity?: number;
  color?: { r: number; g: number; b: number };
}

const shown = (paints: unknown): FakePaint[] =>
  (Array.isArray(paints) ? (paints as FakePaint[]) : []).filter((p) => p.visible !== false && (p.opacity ?? 1) > 0);

function solid(paint: FakePaint, where: string): Rgba {
  if (!paint.color) throw new Error(`The SOLID paint of ${where} has no colour`);
  return { ...paint.color, a: paint.opacity ?? 1 };
}

/** The fixture sets no font size: a line of text fills about 60% of its box, as Inter does at Figma's auto line height. */
function fontSize(node: FakeNode, box: Box): number {
  if (typeof node.fontSize === 'number') return node.fontSize;
  return Math.max(10, Math.min(24, Math.round(box.height * 0.6)));
}

/** What `node`'s tree draws, in the exported node's coordinates, bottom first. */
export function sceneOf(node: FakeNode): Scene {
  const origin = node.absoluteBoundingBox;
  const ops: WireOp[] = [];
  const canvas: Box = { x: 0, y: 0, width: origin.width, height: origin.height };
  const walk = (layer: FakeNode, clip: Box, opacity: number) => {
    if (!layer.visible) return;
    const alpha = opacity * (typeof layer.opacity === 'number' ? layer.opacity : 1);
    const abs = layer.absoluteBoundingBox;
    const box: Box = { x: abs.x - origin.x, y: abs.y - origin.y, width: abs.width, height: abs.height };
    const key = layer.id;
    const round = layer.type === 'ELLIPSE';
    if (layer.type === 'TEXT') {
      // A text layer's fill is its colour; with none visible it draws nothing, as in Figma.
      const paints = shown(layer.fills);
      const paint = paints[paints.length - 1];
      const text = typeof layer.characters === 'string' ? layer.characters : '';
      if (paint && text.trim()) {
        if (paint.type !== 'SOLID') throw new Error(`The wireframe draws text only in a solid colour; ${key} has a ${paint.type} fill`);
        ops.push({ kind: 'text', key, box, clip, opacity: alpha, color: solid(paint, key), text, size: fontSize(layer, box) });
      }
    } else if (!NO_PAINT.has(layer.type)) {
      for (const paint of shown(layer.fills)) {
        if (paint.type === 'SOLID') ops.push({ kind: 'fill', key, box, clip, opacity: alpha, color: solid(paint, key), round });
        else if (paint.type === 'IMAGE') ops.push({ kind: 'image', key, box, clip, opacity: alpha });
        else throw new Error(`The wireframe draws no ${paint.type} paint (on ${key})`);
      }
      const weight = typeof layer.strokeWeight === 'number' ? layer.strokeWeight : 1;
      for (const paint of shown(layer.strokes)) {
        if (paint.type !== 'SOLID') throw new Error(`The wireframe draws strokes only in a solid colour; ${key} has a ${paint.type} stroke`);
        if (weight > 0) ops.push({ kind: 'stroke', key, box, clip, opacity: alpha, color: solid(paint, key), weight, round });
      }
    }
    const kids = layer.type === 'TEXT' ? [] : layer.children;
    if (!kids.length) return;
    const inner = layer.clipsContent ? intersect(clip, box) : clip;
    // Nothing inside an area clipped away shows.
    if (!inner) return;
    const bottomUp = layer.itemReverseZIndex ? [...kids].reverse() : kids;
    for (const kid of bottomUp) walk(kid, inner, alpha);
  };
  walk(node, canvas, 1);
  return { width: Math.round(origin.width), height: Math.round(origin.height), ops };
}
