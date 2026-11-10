/**
 * Keys. Figma's ON_KEY_DOWN triggers hold JavaScript key codes
 * (`KeyboardEvent.keyCode`), modifiers included for a combination. The
 * persona names a key as `KeyboardEvent.key` does ("Enter", "a",
 * "ArrowLeft") or by a common alias ("Esc", "Return", "Space"), and joins
 * a combination with '+', modifiers first ("Shift+Tab", "Ctrl+K",
 * "Cmd+K"). Only keyboard triggers match: the persona has no game
 * controller. `KEY_NAMES` and `MODIFIER_NAMES` are the names accepted; the
 * backend validates the brain's keys against the same lists.
 */

import { bubble, hittableFrame, isShown, type LayerIndex, rootOf, screenOf } from './hitTest';
import type { ProtoTrigger, TraceState } from './model';

const MODIFIERS: Record<string, number> = {
  Shift: 16,
  Control: 17,
  Ctrl: 17,
  Alt: 18,
  Option: 18,
  Meta: 91,
  Cmd: 91,
  Command: 91,
};

const NAMED: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Return: 13,
  ...MODIFIERS,
  Pause: 19,
  CapsLock: 20,
  Escape: 27,
  Esc: 27,
  ' ': 32,
  Space: 32,
  Spacebar: 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Left: 37,
  Up: 38,
  Right: 39,
  Down: 40,
  Insert: 45,
  Delete: 46,
  Del: 46,
  ';': 186,
  '=': 187,
  ',': 188,
  '-': 189,
  '.': 190,
  '/': 191,
  '`': 192,
  '[': 219,
  '\\': 220,
  ']': 221,
  "'": 222,
};

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const FUNCTION_KEYS = Array.from({ length: 12 }, (_, i) => `F${i + 1}`);

export const MODIFIER_NAMES: readonly string[] = Object.keys(MODIFIERS);

/** Every key name accepted on its own or as the last part of a combination. */
export const KEY_NAMES: readonly string[] = [
  ...Object.keys(NAMED),
  ...LETTERS,
  ...LETTERS.toUpperCase(),
  ...'0123456789',
  ...FUNCTION_KEYS,
];

/** The key code of one key: a named key, a letter (either case), a digit, or F1 to F12. Null when Figma has none. */
function codeOf(key: string): number | null {
  if (Object.prototype.hasOwnProperty.call(NAMED, key)) return NAMED[key] as number;
  if (/^[a-z]$/i.test(key)) return key.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(key)) return key.charCodeAt(0);
  const f = /^F([1-9]|1[0-2])$/.exec(key);
  return f ? 111 + Number(f[1]) : null;
}

/** The key codes of a key name or a '+' joined combination ending in a key. Null when a part has no key code. */
export function keyCodes(key: string): number[] | null {
  const parts = key.length > 1 && key.includes('+') ? key.split('+') : [key];
  const last = parts[parts.length - 1] as string;
  const modifiers = parts.slice(0, -1);
  if (modifiers.some((m) => !Object.prototype.hasOwnProperty.call(MODIFIERS, m))) return null;
  const code = codeOf(last);
  return code === null ? null : [...modifiers.map((m) => MODIFIERS[m] as number), code];
}

/** The key code a typed character presses; a line break is Enter. Null for a character with no key of its own. */
export function charCode(char: string): number | null {
  if (char === '\n') return NAMED.Enter as number;
  if (char === '\t') return NAMED.Tab as number;
  return char.length === 1 ? codeOf(char) : null;
}

/** Whether a trigger is a keyboard ON_KEY_DOWN for exactly these key codes, in any order. */
export function matchesKeys(trigger: ProtoTrigger, codes: number[]): boolean {
  if (trigger.type !== 'ON_KEY_DOWN' || trigger.device !== 'KEYBOARD') return false;
  const want = new Set(trigger.keyCodes);
  const got = new Set(codes);
  return want.size === got.size && [...got].every((c) => want.has(c));
}

export interface KeyDeps {
  layers: LayerIndex;
  /** Whether the layer has a keyboard ON_KEY_DOWN reaction for these key codes. */
  handles(s: TraceState, layerKey: string, codes: number[]): boolean;
  /** Fires the layer's keyboard ON_KEY_DOWN reactions for these key codes. */
  fire(s: TraceState, layerKey: string, codes: number[]): void;
}

/**
 * A key press reaches the key triggers of every layer of the screen that
 * can be hit (only the top overlay's while one is open), in paint order,
 * until one of them shows a different frame or overlay.
 */
export function pressKey(deps: KeyDeps, s: TraceState, codes: number[]): void {
  const { layers } = deps;
  const frameId = hittableFrame(layers, s);
  const shown = screenOf(s);
  for (const layer of layers.layers) {
    if (layers.rootOf.get(layer.key) !== frameId || !layers.visible.has(layer.key)) continue;
    if (!deps.handles(s, layer.key, codes)) continue;
    deps.fire(s, layer.key, codes);
    if (screenOf(s) !== shown) return;
  }
}

/**
 * Typing goes to the focused layer (`type` focuses the element typed into
 * first): each character presses its key there, bubbling up to the
 * nearest layer with a trigger for it, until one shows a different frame
 * or overlay. Figma has no text fields, so the text itself goes nowhere.
 */
export function typeText(deps: KeyDeps, s: TraceState, text: string): void {
  const { layers } = deps;
  const focus = s.focus;
  if (!focus || !layers.byKey.has(focus.layerKey) || !isShown(s, focus.frameId)) return;
  if (rootOf(layers, focus.layerKey) !== hittableFrame(layers, s)) return;
  const shown = screenOf(s);
  for (const char of text) {
    const code = charCode(char);
    if (code === null) continue;
    const key = bubble(layers, focus.layerKey, (k) => deps.handles(s, k, [code]));
    if (key === null) continue;
    deps.fire(s, key, [code]);
    if (screenOf(s) !== shown) return;
  }
}
