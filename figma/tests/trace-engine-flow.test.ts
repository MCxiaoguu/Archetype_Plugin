import { describe, expect, it } from 'vitest';
import { apply, start } from '../src/lib/proto/engine';
import type { ElementReading, ProtoAction, ProtoDoc, ProtoReaction, ProtoVariant, RawLayer, ReadingLookup, TraceAction, TraceState } from '../src/lib/proto/model';
import { A, B, C, centres, click, frame, hover, layer, mouse, navigate, node, on, openOverlay, overlayFrame, protoDoc } from './trace-fixtures';

// --- Builders ----------------------------------------------------------------

const edge = (id: string, to: string): ElementReading => ({ id, kind: 'edge', to });
const control = (id: string): ElementReading => ({ id, kind: 'control', to: null });
const gap = (id: string): ElementReading => ({ id, kind: 'gap', to: null });
const changeTo = (variantId: string): ProtoAction => node('CHANGE_TO', variantId);
const type = (element: string, text: string): TraceAction => ({ type: 'type', element, text });

/** A map that reads each `<node> <layerKey>` it lists, and records every lookup. */
function map(readings: Record<string, ElementReading>): ReadingLookup & { asked: string[] } {
  const asked: string[] = [];
  const lookup = (n: string, layerKey: string) => {
    asked.push(`${n} ${layerKey}`);
    return readings[`${n} ${layerKey}`] ?? null;
  };
  return Object.assign(lookup, { asked });
}

/**
 * Screen A: a header `hdr` with a paragraph `para` in it, an unwired `link`
 * and a field `field`, and a wired `btn`.
 */
const screen: RawLayer[] = [
  layer('A', null, [0, 0, 400, 800]),
  layer('hdr', 'A', [0, 0, 400, 80], { type: 'INSTANCE' }),
  layer('para', 'hdr', [20, 20, 300, 40], { type: 'TEXT', text: 'Everything you need to run your money, in one place.' }),
  layer('link', 'A', [20, 100, 100, 30]),
  layer('field', 'A', [20, 150, 200, 40]),
  layer('btn', 'A', [20, 200, 100, 40]),
];

const run = (doc: ProtoDoc, s: TraceState, action: TraceAction, readingOf: ReadingLookup | null, layers: RawLayer[] = screen) =>
  apply(doc, s, action, layers, centres(layers), readingOf);

describe('readings of the flow map', () => {
  describe('a click no reaction handles', () => {
    it('on an edge to another frame navigates there as a drawn NAVIGATE: history, scroll reset, overlays closed, variants kept', () => {
      const doc = protoDoc([A, B, overlayFrame('O', 200, 100)], {}, {});
      const before: TraceState = { ...start(doc, 'A'), scroll: { B: { x: 0, y: 300, areas: {} } }, variants: { B: { tgl: 'v2' } } };
      const { state, outcome, reading } = run(doc, before, click('link'), map({ 'A link': edge('c1', 'B') }));
      expect(outcome).toBe('navigated');
      expect(reading).toEqual(edge('c1', 'B'));
      expect(state).toMatchObject({ frameId: 'B', history: ['A'], overlays: [], variants: { B: { tgl: 'v2' } } });
      expect(state.scroll.B).toBeUndefined();
    });

    it('on an edge to its own node changes nothing, and is already here', () => {
      const doc = protoDoc([A, B]);
      const before = start(doc, 'A');
      const { state, outcome, reading } = run(doc, before, click('link'), map({ 'A link': edge('c2', 'A') }));
      expect(outcome).toBe('already_here');
      expect(reading?.id).toBe('c2');
      expect(state).toMatchObject({ frameId: 'A', history: [], overlays: [] });
    });

    it('on a control is accepted, and on a gap is missing, changing nothing on screen', () => {
      const doc = protoDoc([A, B]);
      const before = start(doc, 'A');
      for (const [reading, outcome] of [
        [control('c3'), 'accepted'],
        [gap('c4'), 'missing'],
      ] as const) {
        const result = run(doc, before, click('link'), map({ 'A link': reading }));
        expect(result.outcome).toBe(outcome);
        expect(result.reading).toEqual(reading);
        expect(result.state).toMatchObject({ frameId: 'A', history: [], overlays: [], variants: {} });
      }
    });

    it('with no reading is nothing happening, as before', () => {
      const doc = protoDoc([A, B]);
      const { outcome, reading } = run(doc, start(doc, 'A'), click('link'), map({}));
      expect(outcome).toBe('nothing_happened');
      expect(reading).toBeNull();
      expect(run(doc, start(doc, 'A'), click('link'), null).outcome).toBe('nothing_happened');
    });

    it("reads the element's own layer only: a paragraph inside a header with a reading gets none", () => {
      const doc = protoDoc([A, B]);
      const lookup = map({ 'A hdr': edge('c5', 'B') });
      const { outcome, reading } = run(doc, start(doc, 'A'), click('para'), lookup);
      expect(outcome).toBe('nothing_happened');
      expect(reading).toBeNull();
      expect(lookup.asked).toEqual(['A para']);
    });

    it('in an overlay reads the overlay as its node', () => {
      const doc = protoDoc([A, B, overlayFrame('O', 200, 100)], { btn: [on('ON_CLICK', openOverlay('O'))] });
      const opened = run(doc, start(doc, 'A'), click('btn'), null).state;
      const withOverlay = [...screen, layer('O', null, [100, 350, 200, 100]), layer('o-link', 'O', [120, 370, 100, 30])];
      const lookup = map({ 'O o-link': edge('c6', 'O') });
      const { outcome } = run(doc, opened, click('o-link'), lookup, withOverlay);
      expect(outcome).toBe('already_here');
      expect(lookup.asked).toEqual(['O o-link']);
    });

    it("stands for the action, whatever the pointer's move changed on the way", () => {
      const doc = protoDoc([A, B, overlayFrame('O', 200, 100)], { link: [mouse('MOUSE_ENTER', 0, openOverlay('O'))] });
      const { state, outcome } = run(doc, start(doc, 'A'), click('link'), map({ 'A link': control('c7') }));
      expect(outcome).toBe('accepted');
      // The move's own change stays: only the outcome is the reading's.
      expect(state.overlays.map((o) => o.frameId)).toEqual(['O']);
    });

    it('plays no reading when the move there navigated, or when it hit nothing', () => {
      const doc = protoDoc([A, B, C], { link: [mouse('MOUSE_ENTER', 0, navigate('C'))] });
      const lookup = map({ 'A link': edge('c8', 'B') });
      const moved = run(doc, start(doc, 'A'), click('link'), lookup);
      expect(moved.outcome).toBe('navigated');
      expect(moved.state.frameId).toBe('C');
      expect(moved.reading).toBeNull();
      expect(lookup.asked).toEqual([]);

      // A layer that draws nothing and takes no click: the hit falls through to nothing.
      const ghost = [layer('A', null, [0, 0, 400, 800]), layer('far', null, [1000, 1000, 10, 10])];
      const missed = apply(doc, start(doc, 'A'), click('far'), ghost, centres(ghost), map({ 'A far': gap('c9') }));
      expect(missed.reading).toBeNull();
    });

    it('aborts as an invalid doc on an edge to a frame the prototype lacks', () => {
      const doc = protoDoc([A, B]);
      expect(() => run(doc, start(doc, 'A'), click('link'), map({ 'A link': edge('c10', '9:99') }))).toThrow(
        expect.objectContaining({ code: 'invalid_doc' }),
      );
    });
  });

  describe('handled', () => {
    // The instance `link` shows v1, whose click changes it to v1.
    const variants: ProtoVariant[] = [
      { id: 'v1', name: 'Off', componentId: 'v1', reactions: { '': [on('ON_CLICK', changeTo('v1'))] } },
      { id: 'v2', name: 'On', componentId: 'v2', reactions: {} },
    ];
    const cases: Array<[string, Record<string, ProtoReaction[]>, Partial<ProtoDoc>]> = [
      ['a CHANGE_TO to the variant already shown', {}, { variantSets: { link: { frameId: 'A', variants } } }],
      ['a false condition', { link: [on('ON_CLICK', { type: 'CONDITIONAL', blocks: [{ condition: { kind: 'literal', value: false }, actions: [navigate('B')] }] })] }, {}],
      ['a delayed MOUSE_UP that only sets a timer', { link: [mouse('MOUSE_UP', 800, navigate('B'))] }, {}],
      ['a reaction on an ancestor', { A: [on('ON_CLICK', { type: 'BACK' })] }, {}],
      ['an unfinished wire beside a finished action', { link: [on('ON_CLICK', node('NAVIGATE', null), { type: 'BACK' })] }, {}],
    ];
    it.each(cases)('by %s: no reading', (_, reactions, extra) => {
      const doc = protoDoc([A, B], reactions, extra);
      const s = { ...start(doc, 'A'), ...(extra.variantSets ? { variants: { A: { link: 'v1' } } } : {}) };
      const lookup = map({ 'A link': gap('c11') });
      const { outcome, reading } = run(doc, s, click('link'), lookup);
      expect(reading).toBeNull();
      expect(outcome).not.toBe('missing');
      expect(lookup.asked).toEqual([]);
    });
  });

  describe('unfinished wires', () => {
    const cases: Array<[string, ProtoAction]> = [
      ['a connection without a destination', node('NAVIGATE', null)],
      ['an overlay without a destination', node('OVERLAY', null)],
      ['a connection to a frame the prototype lacks', navigate('9:99')],
      ['a CHANGE_TO to a variant the prototype lacks', changeTo('9:98')],
    ];
    it.each(cases)("don't handle a click: %s gets its reading", (_, action) => {
      const doc = protoDoc([A, B], { link: [on('ON_CLICK', action)] });
      const { outcome, reading, state } = run(doc, start(doc, 'A'), click('link'), map({ 'A link': gap('c17') }));
      expect(outcome).toBe('missing');
      expect(reading?.id).toBe('c17');
      expect(state.frameId).toBe('A');
    });

    it('without a reading play as before', () => {
      const doc = protoDoc([A, B], { link: [on('ON_CLICK', navigate('9:99'))], field: [on('ON_CLICK', node('NAVIGATE', null))] });
      expect(run(doc, start(doc, 'A'), click('link'), map({}))).toMatchObject({ outcome: 'unsupported', reading: null });
      expect(run(doc, start(doc, 'A'), click('field'), map({}))).toMatchObject({ outcome: 'nothing_happened', reading: null });
    });

    it("on the layer still stop the bubble there: the layer's reading applies, and the ancestor's reaction doesn't fire", () => {
      const doc = protoDoc([A, B], { para: [on('ON_CLICK', node('NAVIGATE', null))], hdr: [on('ON_CLICK', navigate('B'))] });
      const { outcome, reading, state } = run(doc, start(doc, 'A'), click('para'), map({ 'A para': gap('c18') }));
      expect(reading?.id).toBe('c18');
      expect(outcome).toBe('missing');
      expect(state.frameId).toBe('A');
    });
  });

  describe('type', () => {
    it('into a control is accepted; into a gap or an edge it types nothing', () => {
      const doc = protoDoc([A, B]);
      const lookup = map({ 'A field': control('c12'), 'A link': gap('c13'), 'A btn': edge('c14', 'B') });
      expect(run(doc, start(doc, 'A'), type('field', '42'), lookup)).toMatchObject({ outcome: 'accepted', reading: control('c12') });
      expect(run(doc, start(doc, 'A'), type('link', '42'), lookup)).toMatchObject({ outcome: 'typed_nothing', reading: null });
      const typed = run(doc, start(doc, 'A'), type('btn', '42'), lookup);
      expect(typed).toMatchObject({ outcome: 'typed_nothing', reading: null });
      expect(typed.state.frameId).toBe('A');
    });

    it('a typed key a reaction takes is the prototype\'s own', () => {
      const doc = protoDoc([A, B], { field: [{ trigger: { type: 'ON_KEY_DOWN', device: 'KEYBOARD', keyCodes: [52] }, actions: [navigate('B')] }] });
      const { outcome, reading } = run(doc, start(doc, 'A'), type('field', '42'), map({ 'A field': control('c15') }));
      expect(outcome).toBe('navigated');
      expect(reading).toBeNull();
    });
  });

  it('are never used by hover, press_key, drag, scroll, back or wait', () => {
    const doc = protoDoc([A, frame('B', 400, 800)]);
    const lookup = map({ 'A link': gap('c16') });
    const actions: TraceAction[] = [
      hover('link'),
      { type: 'drag', element: 'link' },
      { type: 'press_key', key: 'Enter' },
      { type: 'scroll', direction: 'down', element: 'link' },
      { type: 'back' },
      { type: 'wait', seconds: 1 },
    ];
    for (const action of actions) {
      const { outcome, reading } = run(doc, start(doc, 'A'), action, lookup);
      expect(reading, action.type).toBeNull();
      expect(['accepted', 'missing', 'already_here']).not.toContain(outcome);
    }
    expect(lookup.asked).toEqual([]);
  });
});
