import { describe, expect, it } from 'vitest';
import { actionWords, addFrame, EMPTY_SCREENS, frameShown, HOLD_MS, MAX_FRAMES, outcomeWords, shownFrames, shownRun, stepBack, type LiveFrame } from '../src/lib/liveScreen';
import type { TraceAction } from '../src/lib/proto/model';

const frame = (runId: string, turn: number, change: Partial<LiveFrame> = {}): LiveFrame => ({
  runId,
  turn,
  node: '1:2',
  screenName: 'Dashboard',
  image: new Uint8Array([turn]),
  viewport: { width: 1280, height: 800 },
  action: null,
  target: null,
  outcome: null,
  toName: null,
  decidedAt: null,
  ...change,
});

describe("the live screen's words", () => {
  const click = (element: string): TraceAction => ({ type: 'click', element });
  const target = (label: string) => ({ label, box: [10, 10, 100, 40] as [number, number, number, number], point: { x: 60, y: 30 } });

  it('say what the persona did', () => {
    expect(actionWords(frame('r', 1, { action: click('e3'), target: target('Join Essence') }))).toBe("Clicked 'Join Essence'");
    expect(actionWords(frame('r', 1, { action: { type: 'type', element: 'e2', text: 'Harper' }, target: target('First name') }))).toBe("Typed 'Harper' into First name");
    expect(actionWords(frame('r', 1, { action: { type: 'scroll', direction: 'down' } }))).toBe('Scrolled down');
    expect(actionWords(frame('r', 1, { action: { type: 'hover', element: 'e1' }, target: target('Plans') }))).toBe("Pointed at 'Plans'");
    expect(actionWords(frame('r', 1, { action: { type: 'press_key', key: 'Enter' } }))).toBe('Pressed Enter');
    expect(actionWords(frame('r', 1, { action: { type: 'wait', seconds: 2 } }))).toBe('Waited 2 s');
    expect(actionWords(frame('r', 1, { action: { type: 'back' } }))).toBe('Went back');
    expect(actionWords(frame('r', 1, { action: { type: 'done', claim: 'My bank is connected.' } }))).toBe("Finished: 'My bank is connected.'");
    expect(actionWords(frame('r', 1, { action: { type: 'give_up', reason: 'No routing number field.' } }))).toBe("Gave up: 'No routing number field.'");
    // Still thinking.
    expect(actionWords(frame('r', 1))).toBeNull();
  });

  it('say what came of it', () => {
    const after = (outcome: LiveFrame['outcome'], change: Partial<LiveFrame> = {}) => outcomeWords(frame('r', 1, { action: click('e1'), target: target('Schedule a demo'), outcome, ...change }));
    expect(after('navigated', { toName: 'Checkout' })).toBe('Went to Checkout');
    expect(after('missing')).toBe("'Schedule a demo' doesn't lead anywhere yet");
    expect(after('nothing_happened')).toBe('Nothing happened');
    expect(after('accepted')).toBe("Selected 'Schedule a demo'");
    expect(after('already_here')).toBe('Already on this screen');
    expect(after('opened_overlay', { toName: 'Bank sign in error' })).toBe('Opened Bank sign in error');
    expect(after('scrolled')).toBe('The page scrolled');
    expect(after('unsupported')).toBe("The prototype can't play that");
    expect(after(null)).toBeNull();
  });
});

describe('the live screens kept', () => {
  it("keep each persona's screens by turn, the decision of a turn replacing its screen", () => {
    let s = addFrame(EMPTY_SCREENS, frame('r1', 1));
    s = addFrame(s, frame('r2', 1));
    s = addFrame(s, frame('r1', 1, { action: { type: 'click', element: 'e1' }, outcome: 'navigated' }));
    s = addFrame(s, frame('r1', 2));
    expect(shownFrames(s, 'r1').map((f) => [f.turn, f.outcome])).toEqual([[1, 'navigated'], [2, null]]);
    expect(shownFrames(s, 'r2').map((f) => f.turn)).toEqual([1]);
  });

  it('show the followed persona, else the one that moved last, else the one picked', () => {
    let s = addFrame(addFrame(EMPTY_SCREENS, frame('r1', 1)), frame('r2', 1));
    expect(shownRun(s, null)).toBe('r2');
    s = addFrame(s, frame('r1', 2));
    expect(shownRun(s, null)).toBe('r1');
    expect(shownRun(s, 'r2')).toBe('r2');
    // A chip picks a persona, whatever is followed; following on the canvas is untouched.
    s = { ...s, pick: 'r2' };
    expect(shownRun(s, 'r1')).toBe('r2');
    // A persona with no screen yet isn't shown.
    expect(shownRun(EMPTY_SCREENS, 'r3')).toBeNull();
  });

  it('step back through earlier screens and return to live', () => {
    let s = EMPTY_SCREENS;
    for (const turn of [1, 2, 3]) s = addFrame(s, frame('r1', turn));
    expect(s.back).toBe(0);
    s = stepBack(s, 'r1', 1);
    s = stepBack(s, 'r1', 1);
    s = stepBack(s, 'r1', 1);
    // No further back than the first screen kept.
    expect(s.back).toBe(2);
    s = stepBack(s, 'r1', -1);
    expect(s.back).toBe(1);
    // A new screen while looking back keeps the screen looked at.
    s = addFrame(s, frame('r1', 4));
    expect(s.back).toBe(2);
    expect(stepBack(s, 'r1', 'live').back).toBe(0);
  });

  it(`keep at most ${MAX_FRAMES} in all, dropping the oldest and saying whose`, () => {
    let s = EMPTY_SCREENS;
    for (let turn = 1; turn <= MAX_FRAMES; turn++) s = addFrame(s, frame('r1', turn));
    s = addFrame(s, frame('r2', 1));
    expect(s.frames).toHaveLength(MAX_FRAMES);
    expect(shownFrames(s, 'r1')[0]?.turn).toBe(2);
    expect(s.dropped).toEqual(['r1']);
    // The decision of a kept turn takes no more room.
    s = addFrame(s, frame('r2', 1, { outcome: 'missing' }));
    expect(s.frames).toHaveLength(MAX_FRAMES);
    expect(s.dropped).toEqual(['r1']);
  });
});

describe('the screen shown live', () => {
  it('keeps the screen the persona just acted on for a moment, its target marked, before the next one it thinks on', () => {
    let s = addFrame(EMPTY_SCREENS, frame('r1', 1, { action: { type: 'click', element: 'e1' }, outcome: 'navigated', decidedAt: 10_000 }));
    s = addFrame(s, frame('r1', 2));
    expect(frameShown(s, 'r1', 10_000 + HOLD_MS - 1)).toMatchObject({ frame: { turn: 1 }, holding: true, index: 0, kept: 2 });
    expect(frameShown(s, 'r1', 10_000 + HOLD_MS)).toMatchObject({ frame: { turn: 2 }, holding: false, index: 1 });
    // Looking back, or without a clock, there is no hold.
    expect(frameShown(stepBack(s, 'r1', 'live'), 'r1')).toMatchObject({ frame: { turn: 2 }, holding: false });
    expect(frameShown(stepBack(s, 'r1', 1), 'r1', 10_000).frame?.turn).toBe(1);
  });
});

