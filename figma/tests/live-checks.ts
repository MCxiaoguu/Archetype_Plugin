/**
 * What the live trace run checks in the personas' own words: whether they
 * name a frame they can't have read. Figma's viewer never shows a frame's
 * name, so a persona that writes "Verify phone" on a screen that only says
 * "Enter the 6 digit code" was given the name by the prompt.
 */

import type { ProtoDoc } from '../src/lib/proto/model';
import type { FakeNode } from './fake-figma';
import type { Fake } from './trace-plugin';

/** The text a frame shows: its visible text layers, read from the fake file. */
function shownText(fake: Fake, frameId: string): string {
  const frame = fake.world.nodes.get(frameId);
  if (!frame) throw new Error(`The frame ${frameId} isn't in the file`);
  const out: string[] = [];
  const walk = (node: FakeNode) => {
    if (!node.visible) return;
    if (node.type === 'TEXT' && typeof node.characters === 'string') out.push(node.characters);
    for (const child of node.children) walk(child);
  };
  walk(frame);
  return out.join('\n');
}

/**
 * The frame names whose own visible text never shows them, split into those
 * the persona can't have read (`hidden`) and those `told` (what the run gave
 * the persona: its briefing and everything its screens said) contains, such
 * as a goal frame the success criterion names.
 */
export function hiddenFrameNames(fake: Fake, doc: ProtoDoc, told: string): { hidden: string[]; told: string[] } {
  const hidden: string[] = [];
  const said: string[] = [];
  for (const frame of doc.frames) {
    if (namesIn(shownText(fake, frame.id), [frame.name]).length) continue;
    const into = namesIn(told, [frame.name]).length ? said : hidden;
    if (!into.includes(frame.name)) into.push(frame.name);
  }
  return { hidden, told: said };
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The names `text` uses as the prototype writes them: the exact name, case
 * included, as a whole phrase. Quoting a screen's title matches; plain
 * speech that shares the words ("get my bank connected") doesn't.
 */
export function namesIn(text: string, names: readonly string[]): string[] {
  return names.filter((name) => new RegExp(`(?<![\\p{L}\\p{N}])${escape(name)}(?![\\p{L}\\p{N}])`, 'u').test(text));
}
