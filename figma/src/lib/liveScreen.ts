/**
 * The Live screen card's state and words: each screen a persona saw in
 * this panel's run, as the session rendered it for the turn (no render of
 * its own), with what the persona did there and what came of it.
 */

import type { ElementBox, Point, TraceAction, TraceOutcome } from './proto/model';

/** One screen a persona saw, and once its turn is decided, what it did there. */
export interface LiveFrame {
  runId: string;
  turn: number;
  /** The node the screen shows on top: the topmost overlay, else the frame. */
  node: string;
  screenName: string;
  /** The viewport as the session posted it (a JPEG). */
  image: Uint8Array;
  viewport: { width: number; height: number };
  /** What the persona did on this screen; null while it thinks. */
  action: TraceAction | null;
  /** The element the action named: its label, its box in the viewport, and where a click landed. */
  target: { label: string; box: ElementBox; point: Point } | null;
  /** What came of the action; null while it thinks, and for the action that ended the run. */
  outcome: TraceOutcome | null;
  /** The screen the action showed after, for the words. */
  toName: string | null;
  /** When the decision came (ms); null while the persona thinks. */
  decidedAt: number | null;
}

/** The most screens kept in all, across personas: each is a viewport JPEG. */
export const MAX_FRAMES = 40;

export interface LiveScreens {
  /** Every screen kept, oldest first. */
  frames: LiveFrame[];
  /** The runs that moved, the most recent last. */
  order: string[];
  /** The runs whose earlier screens were dropped to keep at most MAX_FRAMES. */
  dropped: string[];
  /** The persona picked with a chip; null shows the followed one, else the one that moved last. */
  pick: string | null;
  /** How many screens back from the latest of `viewing` the card shows; 0 is live. */
  back: number;
  viewing: string | null;
}

export const EMPTY_SCREENS: LiveScreens = { frames: [], order: [], dropped: [], pick: null, back: 0, viewing: null };

/** Adds a screen, or the decision of a turn already kept; the oldest goes once more than MAX_FRAMES are kept. */
export function addFrame(s: LiveScreens, frame: LiveFrame): LiveScreens {
  const at = s.frames.findIndex((f) => f.runId === frame.runId && f.turn === frame.turn);
  const order = [...s.order.filter((id) => id !== frame.runId), frame.runId];
  if (at >= 0) {
    const frames = [...s.frames];
    frames[at] = frame;
    return { ...s, frames, order };
  }
  let frames = [...s.frames, frame];
  let dropped = s.dropped;
  while (frames.length > MAX_FRAMES) {
    const gone = frames[0] as LiveFrame;
    frames = frames.slice(1);
    if (!dropped.includes(gone.runId)) dropped = [...dropped, gone.runId];
  }
  // Looking back at this persona, the screen looked at stays.
  const back = s.back > 0 && s.viewing === frame.runId ? s.back + 1 : s.back;
  return { ...s, frames, order, dropped, back };
}

/** A persona's screens kept, by turn. */
export function shownFrames(s: LiveScreens, runId: string | null): LiveFrame[] {
  return runId === null ? [] : s.frames.filter((f) => f.runId === runId).sort((a, b) => a.turn - b.turn);
}

const hasFrames = (s: LiveScreens, runId: string | null) => runId !== null && s.frames.some((f) => f.runId === runId);

/** The persona the card shows: the one picked, else the followed one, else the one that moved last. */
export function shownRun(s: LiveScreens, following: string | null): string | null {
  if (hasFrames(s, s.pick)) return s.pick;
  if (hasFrames(s, following)) return following;
  for (let i = s.order.length - 1; i >= 0; i--) if (hasFrames(s, s.order[i] as string)) return s.order[i] as string;
  return null;
}

/** One screen older (1), newer (-1), or back to live, for the persona shown. */
export function stepBack(s: LiveScreens, runId: string, step: 1 | -1 | 'live'): LiveScreens {
  if (step === 'live') return { ...s, back: 0, viewing: runId };
  const kept = shownFrames(s, runId).length;
  const from = s.viewing === runId ? s.back : 0;
  return { ...s, back: Math.max(0, Math.min(kept - 1, from + step)), viewing: runId };
}

/** How long, live, the card keeps the screen a persona just acted on, its target marked, before the next one. */
export const HOLD_MS = 1500;

/**
 * The screen the card shows for the persona: `back` screens before its
 * latest. Live, the latest is the next screen the persona thinks on from
 * the moment it renders, so the one it just acted on stays for HOLD_MS
 * after `now`'s decision, to show what it did there.
 */
export function frameShown(s: LiveScreens, runId: string | null, now: number | null = null): { frame: LiveFrame | null; index: number; kept: number; holding: boolean } {
  const frames = shownFrames(s, runId);
  const back = s.viewing === runId ? Math.min(s.back, frames.length - 1) : 0;
  let index = frames.length - 1 - back;
  const prev = frames[index - 1];
  const holding = back === 0 && now !== null && !frames[index]?.action && !!prev?.decidedAt && now - prev.decidedAt < HOLD_MS;
  if (holding) index -= 1;
  return { frame: frames[index] ?? null, index, kept: frames.length, holding };
}

const quote = (text: string) => `'${text}'`;

/** What the persona did, in the panel's words; null while it thinks. */
export function actionWords(frame: LiveFrame): string | null {
  const a = frame.action;
  if (!a) return null;
  const label = frame.target?.label ?? 'it';
  switch (a.type) {
    case 'click':
      return `Clicked ${quote(label)}`;
    case 'hover':
      return `Pointed at ${quote(label)}`;
    case 'drag':
      return `Dragged ${quote(label)}`;
    case 'type':
      return `Typed ${quote(a.text)} into ${label}`;
    case 'scroll':
      return frame.target ? `Scrolled ${a.direction} in ${quote(label)}` : `Scrolled ${a.direction}`;
    case 'press_key':
      return `Pressed ${a.key}`;
    case 'wait':
      return `Waited ${a.seconds} s`;
    case 'back':
      return 'Went back';
    case 'done':
      return `Finished: ${quote(a.claim)}`;
    case 'give_up':
      return `Gave up: ${quote(a.reason)}`;
  }
}

/** What came of it, in the panel's words; null while it thinks, and for the action that ended the run. */
export function outcomeWords(frame: LiveFrame): string | null {
  const label = frame.target?.label ?? 'that';
  const to = frame.toName ?? 'another screen';
  switch (frame.outcome) {
    case null:
      return null;
    case 'navigated':
      return `Went to ${to}`;
    case 'swapped':
      return `Changed to ${to}`;
    case 'opened_overlay':
      return `Opened ${to}`;
    case 'closed_overlay':
      return 'Closed the overlay';
    case 'changed_state':
      return 'Something on the screen changed';
    case 'scrolled':
      return 'The page scrolled';
    case 'timers_fired':
      return 'Something changed after a wait';
    case 'nothing_happened':
      return 'Nothing happened';
    case 'scroll_at_end':
      return 'It was already at the end';
    case 'back_empty':
      return 'There was nowhere to go back to';
    case 'waited':
      return 'Nothing changed while waiting';
    case 'typed_nothing':
      return 'Typing did nothing here';
    case 'left_prototype':
      return 'Opened a link outside the prototype';
    case 'unsupported':
      return "The prototype can't play that";
    case 'already_here':
      return 'Already on this screen';
    case 'accepted':
      return `Selected ${quote(label)}`;
    case 'missing':
      return `${quote(label)} doesn't lead anywhere yet`;
  }
}
