import { describe, expect, it } from 'vitest';
import { settle, start, viewportFor } from '../src/lib/proto/engine';
import { EngineError } from '../src/lib/proto/errors';
import type { OverflowDirection, OverlayPosition, ProtoAction, TraceAction, TraceState } from '../src/lib/proto/model';
import {
  A,
  act,
  B,
  box,
  C,
  click,
  deepFreeze,
  frame,
  hover,
  layer,
  link,
  mouse,
  navigate,
  node,
  on,
  openOverlay,
  overlayFrame,
  protoDoc,
  screenA,
  scroll,
  urls,
} from './trace-fixtures';

// --- Start and viewport ---------------------------------------------------

describe('viewportFor', () => {
  it.each([
    { size: [1280, 2000], viewport: { width: 1280, height: 900 } },
    { size: [768, 1000], viewport: { width: 768, height: 900 } },
    { size: [767, 1000], viewport: { width: 767, height: 844 } },
    { size: [375, 2000], viewport: { width: 375, height: 844 } },
    { size: [375, 600], viewport: { width: 375, height: 600 } },
  ])('a $size.0x$size.1 start frame gives a $viewport.width x $viewport.height viewport', ({ size, viewport }) => {
    const [width, height] = size as [number, number];
    expect(viewportFor(protoDoc([frame('S', width, height)]), 'S')).toEqual(viewport);
  });

  it('refuses a start frame the document does not have', () => {
    expect(() => viewportFor(protoDoc([A]), 'nope')).toThrow(EngineError);
  });
});

describe('start', () => {
  it('shows the start frame with no history, the viewport and the document hash', () => {
    const s = start(protoDoc([frame('S', 1280, 2400)]), 'S');
    expect(s).toMatchObject({ frameId: 'S', overlays: [], history: [], scroll: {}, clockMs: 0, timers: [], docHash: 'hash-1' });
    expect(s.viewport).toEqual({ width: 1280, height: 900 });
    expect(s.pointer).toEqual({ point: null, over: [], pressing: null, held: [] });
  });
});

// --- Navigation and history -------------------------------------------------

describe('navigation', () => {
  it('NAVIGATE shows the destination and pushes history', () => {
    const doc = protoDoc([A, B], { btn: [on('ON_CLICK', navigate('B'))] });
    const { state, outcome } = act(doc, start(doc, 'A'), click('btn'), screenA);
    expect(outcome).toBe('navigated');
    expect(state.frameId).toBe('B');
    expect(state.history).toEqual(['A']);
  });

  const tallFrom = frame('T1', 400, 2000);
  const tallTo = frame('T2', 400, 1600); // the viewport is 400x844, so the range is 1600 - 844 = 756
  it.each([
    { when: 'resetScrollPosition is true', reset: true, preserve: true, fromY: 300, y: 0 },
    { when: 'the deprecated preserveScrollPosition is false', reset: false, preserve: false, fromY: 300, y: 0 },
    { when: 'neither asks for a reset (kept)', reset: false, preserve: true, fromY: 300, y: 300 },
    { when: 'neither asks for a reset (kept within range)', reset: false, preserve: true, fromY: 1100, y: 756 },
  ])('scroll on NAVIGATE when $when', ({ reset, preserve, fromY, y }) => {
    const doc = protoDoc([tallFrom, tallTo], {
      btn: [on('ON_CLICK', navigate('T2', { resetScrollPosition: reset, preserveScrollPosition: preserve }))],
    });
    const s = start(doc, 'T1');
    s.scroll = { T1: { x: 0, y: fromY, areas: {} }, T2: { x: 0, y: 40, areas: { list: { x: 0, y: 90 } } } };
    const layers = [layer('T1', null, [0, -fromY, 400, 2000]), layer('btn', 'T1', [20, 20, 100, 40])];
    const { state } = act(doc, s, click('btn'), layers);
    expect(state.frameId).toBe('T2');
    expect(state.scroll.T2?.y ?? 0).toBe(y);
    expect(state.scroll.T2?.areas ?? {}).toEqual(y === 0 ? {} : { list: { x: 0, y: 90 } });
    expect(state.scroll.T1).toEqual({ x: 0, y: fromY, areas: {} });
  });

  it.each([
    { reset: true, variants: { A: { i2: 'v3' } } },
    { reset: false, variants: { A: { i2: 'v3' }, B: { i1: 'v2' } } },
  ])('resetInteractiveComponents $reset clears only the overrides under the destination', ({ reset, variants }) => {
    const doc = protoDoc([A, B], { btn: [on('ON_CLICK', navigate('B', { resetInteractiveComponents: reset }))] });
    const s = start(doc, 'A');
    s.variants = { A: { i2: 'v3' }, B: { i1: 'v2' } };
    expect(act(doc, s, click('btn'), screenA).state.variants).toEqual(variants);
  });

  it('SWAP replaces the base frame without adding history', () => {
    const doc = protoDoc([A, B, C], { btn: [on('ON_CLICK', node('SWAP', 'C'))] });
    const s = start(doc, 'A');
    s.history = ['B'];
    const { state, outcome } = act(doc, s, click('btn'), screenA);
    expect(outcome).toBe('swapped');
    expect(state.frameId).toBe('C');
    expect(state.history).toEqual(['B']);
  });

  it('SWAP from inside an overlay replaces the top overlay', () => {
    const M = overlayFrame('M', 200, 100);
    const N = overlayFrame('N', 200, 200, { position: 'TOP_LEFT', closeOnOutsideClick: true });
    const doc = protoDoc([A, M, N], { next: [on('ON_CLICK', node('SWAP', 'N'))] });
    const s = start(doc, 'A');
    s.overlays = [{ frameId: 'M', position: 'CENTER', origin: { x: 100, y: 350 }, closeOnOutsideClick: false }];
    const layers = [...screenA, layer('M', null, [100, 350, 200, 100]), layer('next', 'M', [120, 360, 80, 30])];
    const { state, outcome } = act(doc, s, click('next'), layers);
    expect(outcome).toBe('swapped');
    expect(state.frameId).toBe('A');
    expect(state.history).toEqual([]);
    expect(state.overlays).toEqual([{ frameId: 'N', position: 'TOP_LEFT', origin: { x: 0, y: 0 }, closeOnOutsideClick: true }]);
  });

  it('back pops history and closes open overlays', () => {
    const doc = protoDoc([A, B, overlayFrame('M', 200, 100)]);
    const s = start(doc, 'B');
    s.history = ['A'];
    s.overlays = [{ frameId: 'M', position: 'CENTER', origin: { x: 100, y: 350 }, closeOnOutsideClick: false }];
    const { state, outcome } = act(doc, s, { type: 'back' }, [layer('B', null, [0, 0, 400, 800]), layer('M', null, [100, 350, 200, 100])]);
    expect(outcome).toBe('navigated');
    expect(state).toMatchObject({ frameId: 'A', history: [], overlays: [] });
  });

  it('back with no history gives back_empty', () => {
    const doc = protoDoc([A]);
    const s = start(doc, 'A');
    const { state, outcome } = act(doc, s, { type: 'back' }, screenA);
    expect(outcome).toBe('back_empty');
    expect(state).toEqual(s);
  });

  it.each([
    { history: ['B'], outcome: 'navigated', frameId: 'B' },
    { history: [], outcome: 'nothing_happened', frameId: 'A' },
  ])('a BACK reaction with history $history gives $outcome', ({ history, outcome, frameId }) => {
    const doc = protoDoc([A, B], { btn: [on('ON_CLICK', { type: 'BACK' })] });
    const s = start(doc, 'A');
    s.history = history;
    const result = act(doc, s, click('btn'), screenA);
    expect(result.outcome).toBe(outcome);
    expect(result.state.frameId).toBe(frameId);
  });

  it.each([
    { navigation: 'NAVIGATE' as const },
    { navigation: 'SWAP' as const },
    { navigation: 'OVERLAY' as const },
    { navigation: 'SCROLL_TO' as const },
  ])('a $navigation with no destination does nothing, as in the viewer', ({ navigation }) => {
    const doc = protoDoc([A], { btn: [on('ON_CLICK', node(navigation, null))] });
    const { state, outcome, effects } = act(doc, start(doc, 'A'), click('btn'), screenA);
    expect(outcome).toBe('nothing_happened');
    expect(effects).toEqual([]);
    expect(state.frameId).toBe('A');
  });

  it.each([
    { navigation: 'NAVIGATE' as const },
    { navigation: 'SWAP' as const },
    { navigation: 'OVERLAY' as const },
    { navigation: 'SCROLL_TO' as const },
  ])("a $navigation to a destination the document doesn't have is unsupported, not a misclick", ({ navigation }) => {
    const doc = protoDoc([A], { btn: [on('ON_CLICK', node(navigation, '2:99'))] });
    const { state, outcome, effects } = act(doc, start(doc, 'A'), click('btn'), screenA);
    expect(outcome).toBe('unsupported');
    expect(effects).toEqual([{ type: 'unsupported', action: 'missing_destination:2:99' }]);
    expect(state.frameId).toBe('A');
  });
});

// --- Overlays -----------------------------------------------------------------

describe('overlays', () => {
  // Viewport 400x800 (frame A); the overlay is 200x100; the trigger's box is (30, 40, 50, 20).
  const trigger = layer('btn', 'A', [30, 40, 50, 20]);
  it.each<{ position: OverlayPosition; origin: { x: number; y: number } }>([
    { position: 'CENTER', origin: { x: 100, y: 350 } },
    { position: 'TOP_LEFT', origin: { x: 0, y: 0 } },
    { position: 'TOP_CENTER', origin: { x: 100, y: 0 } },
    { position: 'TOP_RIGHT', origin: { x: 200, y: 0 } },
    { position: 'BOTTOM_LEFT', origin: { x: 0, y: 700 } },
    { position: 'BOTTOM_CENTER', origin: { x: 100, y: 700 } },
    { position: 'BOTTOM_RIGHT', origin: { x: 200, y: 700 } },
    { position: 'MANUAL', origin: { x: 40, y: 65 } },
  ])('OVERLAY at $position opens with its origin at ($origin.x, $origin.y)', ({ position, origin }) => {
    const O = overlayFrame('O', 200, 100, { position, closeOnOutsideClick: true });
    const doc = protoDoc([A, O], { btn: [on('ON_CLICK', openOverlay('O', { overlayRelativePosition: { x: 10, y: 25 } }))] });
    const { state, outcome } = act(doc, start(doc, 'A'), click('btn'), [layer('A', null, [0, 0, 400, 800]), trigger]);
    expect(outcome).toBe('opened_overlay');
    expect(state.overlays).toEqual([{ frameId: 'O', position, origin, closeOnOutsideClick: true }]);
    expect(state.history).toEqual([]);
  });

  it('places a MANUAL overlay from the trigger box before clipping', () => {
    const O = overlayFrame('O', 200, 100, { position: 'MANUAL' });
    const doc = protoDoc([A, O], { btn: [on('ON_CLICK', openOverlay('O', { overlayRelativePosition: { x: 10, y: 25 } }))] });
    const clipped = layer('btn', 'A', [30, 40, 50, 20], { unclippedBox: box([30, 30, 50, 30]) });
    const { state } = act(doc, start(doc, 'A'), click('btn'), [layer('A', null, [0, 0, 400, 800]), clipped]);
    expect(state.overlays[0]?.origin).toEqual({ x: 40, y: 55 });
  });

  it('refuses a MANUAL overlay whose action has no offset', () => {
    const doc = protoDoc([A, overlayFrame('O', 200, 100, { position: 'MANUAL' })], { btn: [on('ON_CLICK', openOverlay('O'))] });
    expect(() => act(doc, start(doc, 'A'), click('btn'), screenA)).toThrow(EngineError);
  });

  it('does not open an overlay that is already showing', () => {
    const doc = protoDoc([A, overlayFrame('O', 200, 100)], { btn: [on('ON_CLICK', openOverlay('O'), openOverlay('O'))] });
    const { state } = act(doc, start(doc, 'A'), click('btn'), screenA);
    expect(state.overlays.map((o) => o.frameId)).toEqual(['O']);
  });

  const M = overlayFrame('M', 200, 100);
  const N = overlayFrame('N', 100, 100);
  const withM = (closeOnOutsideClick: boolean): TraceState => {
    const s = start(protoDoc([A]), 'A');
    s.overlays = [{ frameId: 'M', position: 'CENTER', origin: { x: 100, y: 350 }, closeOnOutsideClick }];
    return s;
  };
  const screenWithM = [...screenA, layer('M', null, [100, 350, 200, 100]), layer('ok', 'M', [120, 360, 60, 30])];

  it('CLOSE closes the top overlay', () => {
    const doc = protoDoc([A, M, N], { x: [on('ON_CLICK', { type: 'CLOSE' })] });
    const s = withM(false);
    s.overlays.push({ frameId: 'N', position: 'CENTER', origin: { x: 150, y: 350 }, closeOnOutsideClick: false });
    const layers = [...screenWithM, layer('N', null, [150, 350, 100, 100]), layer('x', 'N', [220, 355, 20, 20])];
    const { state, outcome } = act(doc, s, click('x'), layers);
    expect(outcome).toBe('closed_overlay');
    expect(state.overlays.map((o) => o.frameId)).toEqual(['M']);
  });

  it('a click outside a close-on-outside overlay closes it and fires nothing underneath', () => {
    const doc = protoDoc([A, B, M], { btn: [on('ON_CLICK', navigate('B'))] });
    const { state, outcome } = act(doc, withM(true), click('btn'), screenWithM);
    expect(outcome).toBe('closed_overlay');
    expect(state).toMatchObject({ frameId: 'A', history: [], overlays: [] });
  });

  it('with an overlay open, a click on the layers underneath hits nothing', () => {
    const doc = protoDoc([A, B, M], { btn: [on('ON_CLICK', navigate('B'))] });
    const { state, outcome } = act(doc, withM(false), click('btn'), screenWithM);
    expect(outcome).toBe('nothing_happened');
    expect(state.frameId).toBe('A');
    expect(state.overlays.map((o) => o.frameId)).toEqual(['M']);
  });

  it('a click inside the overlay reaches its layers', () => {
    const doc = protoDoc([A, B, M], { ok: [on('ON_CLICK', navigate('B'))] });
    const { state, outcome } = act(doc, withM(true), click('ok'), screenWithM);
    expect(outcome).toBe('navigated');
    expect(state).toMatchObject({ frameId: 'B', history: ['A'], overlays: [] });
  });
});

// --- Hit-testing ------------------------------------------------------------------

describe('hit-testing by point', () => {
  const doc = protoDoc([A, B], { hot: [on('ON_CLICK', navigate('B'))] });
  const root = layer('A', null, [0, 0, 400, 800]);
  const image = layer('img', 'A', [0, 0, 400, 300], { type: 'RECTANGLE', roleHint: 'image' });
  const hotspot = layer('hot', 'A', [50, 50, 100, 40], { type: 'RECTANGLE', hasReactions: true });

  it.each([
    { order: 'a transparent hotspot above an image fires its reaction', layers: [root, image, hotspot], outcome: 'navigated' },
    { order: 'an image above a hotspot covers it', layers: [root, hotspot, image], outcome: 'nothing_happened' },
  ])('$order', ({ layers, outcome }) => {
    expect(act(doc, start(doc, 'A'), click('hot'), layers).outcome).toBe(outcome);
  });

  it('a hidden layer is not hit, so the layer under it is', () => {
    const d = protoDoc([A, B, C], { hot: [on('ON_CLICK', navigate('B'))], cover: [on('ON_CLICK', navigate('C'))] });
    const cover = layer('cover', 'A', [50, 50, 100, 40], { visible: false });
    expect(act(d, start(d, 'A'), click('hot'), [root, hotspot, cover]).state.frameId).toBe('B');
  });

  it('a layer inside a hidden group is not hit either', () => {
    const d = protoDoc([A, C], { hot: [on('ON_CLICK', navigate('C'))] });
    const group = layer('group', 'A', [0, 0, 400, 400], { visible: false });
    const inside = layer('hot', 'group', [50, 50, 100, 40]);
    expect(act(d, start(d, 'A'), click('hot'), [root, group, inside]).outcome).toBe('nothing_happened');
  });

  it('a click on a child without a reaction bubbles to its parent', () => {
    const d = protoDoc([A, B], { card: [on('ON_CLICK', navigate('B'))] });
    const layers = [root, layer('card', 'A', [20, 100, 200, 100]), layer('title', 'card', [30, 110, 100, 20], { type: 'TEXT' })];
    expect(act(d, start(d, 'A'), click('title'), layers).state.frameId).toBe('B');
  });

  it('a point outside a box clipped by clipsContent does not hit it', () => {
    const d = protoDoc([A, B], { row: [on('ON_CLICK', navigate('B'))] });
    const list = layer('list', 'A', [0, 400, 400, 200]);
    // The row is drawn from y = 380 but its list clips it at y = 400.
    const row = layer('row', 'list', [0, 400, 400, 40], { unclippedBox: box([0, 380, 400, 60]) });
    const layers = [root, list, row];
    const above = { row: { layerKey: 'row', point: { x: 200, y: 390 } } };
    const inside = { row: { layerKey: 'row', point: { x: 200, y: 420 } } };
    expect(act(d, start(d, 'A'), click('row'), layers, above).outcome).toBe('nothing_happened');
    expect(act(d, start(d, 'A'), click('row'), layers, inside).outcome).toBe('navigated');
  });

  it('a MOUSE_DOWN that navigates stops the rest of the click sequence', () => {
    const d = protoDoc([A, B, C], { btn: [mouse('MOUSE_DOWN', 0, navigate('B')), on('ON_CLICK', navigate('C'))] });
    const { state } = act(d, start(d, 'A'), click('btn'), screenA);
    expect(state.frameId).toBe('B');
    expect(state.history).toEqual(['A']);
  });

  it('fires MOUSE_DOWN, ON_PRESS, MOUSE_UP and ON_CLICK in that order', () => {
    const d = protoDoc([A], {
      btn: [on('ON_CLICK', link('click')), mouse('MOUSE_UP', 0, link('up')), on('ON_PRESS', link('press')), mouse('MOUSE_DOWN', 0, link('down'))],
    });
    expect(urls(act(d, start(d, 'A'), click('btn'), screenA).effects)).toEqual(['down', 'press', 'up', 'click']);
  });

  it('bubbles each trigger on its own: a press on the child, the click on its parent', () => {
    const d = protoDoc([A], { card: [on('ON_CLICK', link('card click'))], title: [mouse('MOUSE_DOWN', 0, link('title down'))] });
    const layers = [layer('A', null, [0, 0, 400, 800]), layer('card', 'A', [20, 100, 200, 100]), layer('title', 'card', [30, 110, 100, 20])];
    expect(urls(act(d, start(d, 'A'), click('title'), layers).effects)).toEqual(['title down', 'card click']);
  });
});

// --- Pointer ----------------------------------------------------------------------

describe('pointer', () => {
  const root = layer('A', null, [0, 0, 400, 800]);
  const x = layer('x', 'A', [0, 0, 100, 100]);
  const y = layer('y', 'A', [200, 0, 100, 100]);
  const P1 = overlayFrame('P1', 10, 10);

  it('hover fires MOUSE_LEAVE on the old layer, then MOUSE_ENTER on the new one', () => {
    const doc = protoDoc([A], { x: [mouse('MOUSE_LEAVE', 0, link('leave x'))], y: [mouse('MOUSE_ENTER', 0, link('enter y'))] });
    const over = act(doc, start(doc, 'A'), hover('x'), [root, x, y]).state;
    expect(over.pointer.over).toEqual(['x', 'A']);
    const { state, effects } = act(doc, over, hover('y'), [root, x, y]);
    expect(urls(effects)).toEqual(['leave x', 'enter y']);
    expect(state.pointer).toMatchObject({ point: { x: 250, y: 50 }, over: ['y', 'A'] });
  });

  it('enters from the outermost layer in, and leaves from the innermost out', () => {
    const doc = protoDoc([A], {
      card: [mouse('MOUSE_ENTER', 0, link('enter card')), mouse('MOUSE_LEAVE', 0, link('leave card'))],
      title: [mouse('MOUSE_ENTER', 0, link('enter title')), mouse('MOUSE_LEAVE', 0, link('leave title'))],
    });
    const layers = [root, layer('card', 'A', [0, 0, 300, 100]), layer('title', 'card', [0, 0, 100, 50]), layer('away', 'A', [0, 300, 50, 50])];
    const entered = act(doc, start(doc, 'A'), hover('title'), layers);
    expect(urls(entered.effects)).toEqual(['enter card', 'enter title']);
    expect(urls(act(doc, entered.state, hover('away'), layers).effects)).toEqual(['leave title', 'leave card']);
  });

  it('moving between two children of a layer neither leaves nor enters that layer', () => {
    const doc = protoDoc([A], { card: [mouse('MOUSE_LEAVE', 0, link('leave')), mouse('MOUSE_ENTER', 0, link('enter'))] });
    const card = layer('card', 'A', [0, 0, 300, 100]);
    const layers = [root, card, layer('title', 'card', [0, 0, 100, 50]), layer('pic', 'card', [150, 0, 100, 50])];
    const entered = act(doc, start(doc, 'A'), hover('title'), layers);
    expect(urls(entered.effects)).toEqual(['enter']);
    const moved = act(doc, entered.state, hover('pic'), layers);
    expect(moved.outcome).toBe('nothing_happened');
    expect(moved.effects).toEqual([]);
  });

  it('a "while hovering" overlay stays open over the trigger or the overlay, and closes on leave', () => {
    const menu = overlayFrame('menu', 200, 300, { position: 'MANUAL' });
    const doc = protoDoc([A, menu], { trigger: [on('ON_HOVER', openOverlay('menu', { overlayRelativePosition: { x: 0, y: 30 } }))] });
    const trigger = layer('trigger', 'A', [10, 10, 80, 30]);
    const label = layer('label', 'trigger', [20, 15, 40, 20], { type: 'TEXT' });
    const elsewhere = layer('far', 'A', [300, 600, 50, 50]);
    const closed = [root, trigger, label, elsewhere];
    const open = [...closed, layer('menu', null, [10, 40, 200, 300]), layer('item', 'menu', [20, 50, 100, 20])];

    const opened = act(doc, start(doc, 'A'), hover('trigger'), closed);
    expect(opened.outcome).toBe('opened_overlay');
    expect(opened.state.overlays).toEqual([{ frameId: 'menu', position: 'MANUAL', origin: { x: 10, y: 40 }, closeOnOutsideClick: false }]);

    // Across the trigger's own label: still over the trigger.
    const onLabel = act(doc, opened.state, hover('label'), open);
    expect(onLabel.outcome).toBe('nothing_happened');
    expect(onLabel.state.overlays.map((o) => o.frameId)).toEqual(['menu']);
    const onItem = act(doc, onLabel.state, hover('item'), open);
    expect(onItem.outcome).toBe('nothing_happened');
    const backOnTrigger = act(doc, onItem.state, hover('trigger'), open);
    expect(backOnTrigger.state.overlays.map((o) => o.frameId)).toEqual(['menu']);

    const left = act(doc, backOnTrigger.state, hover('far'), open);
    expect(left.outcome).toBe('closed_overlay');
    expect(left.state.overlays).toEqual([]);
    expect(left.state.pointer.held).toEqual([]);
  });

  it('moving off a "while hovering" overlay lets a click land on the layer underneath', () => {
    const menu = overlayFrame('menu', 200, 300, { position: 'TOP_LEFT' });
    const doc = protoDoc([A, B, menu], { trigger: [on('ON_HOVER', openOverlay('menu'))], far: [on('ON_CLICK', navigate('B'))] });
    const layers = [root, layer('trigger', 'A', [10, 10, 80, 30]), layer('far', 'A', [300, 600, 50, 50])];
    const opened = act(doc, start(doc, 'A'), hover('trigger'), layers).state;
    const { state, outcome } = act(doc, opened, click('far'), [...layers, layer('menu', null, [0, 0, 200, 300])]);
    expect(outcome).toBe('navigated');
    expect(state).toMatchObject({ frameId: 'B', overlays: [] });
  });

  it('a "while pressing" overlay closes again at release', () => {
    const doc = protoDoc([A, overlayFrame('P', 10, 10)], { btn: [on('ON_PRESS', openOverlay('P'))] });
    const { state, outcome } = act(doc, start(doc, 'A'), click('btn'), screenA);
    expect(outcome).toBe('nothing_happened');
    expect(state.overlays).toEqual([]);
    expect(state.pointer).toMatchObject({ pressing: null, held: [] });
  });

  it('a "while pressing" overlay that closes at release stops nothing: MOUSE_UP and ON_CLICK still fire', () => {
    const doc = protoDoc([A, B, overlayFrame('P', 10, 10)], { btn: [on('ON_PRESS', openOverlay('P')), on('ON_CLICK', navigate('B'))] });
    const { state, outcome } = act(doc, start(doc, 'A'), click('btn'), screenA);
    expect(outcome).toBe('navigated');
    expect(state).toMatchObject({ frameId: 'B', overlays: [] });
  });

  it("an overlay the click's own pointer move opens, not yet drawn, doesn't intercept the click", () => {
    const tip = overlayFrame('tip', 100, 40, { position: 'TOP_LEFT', closeOnOutsideClick: true });
    const doc = protoDoc([A, B, tip], { btn: [on('ON_HOVER', openOverlay('tip')), on('ON_CLICK', navigate('B'))] });
    const { state, outcome } = act(doc, start(doc, 'A'), click('btn'), screenA);
    expect(outcome).toBe('navigated');
    expect(state.frameId).toBe('B');
  });

  it('refuses a screen whose open overlay was not measured, rather than treating a click as outside it', () => {
    const doc = protoDoc([A, B, overlayFrame('M', 200, 100, { closeOnOutsideClick: true })], { btn: [on('ON_CLICK', navigate('B'))] });
    const s = start(doc, 'A');
    s.overlays = [{ frameId: 'M', position: 'CENTER', origin: { x: 100, y: 350 }, closeOnOutsideClick: true }];
    expect(() => act(doc, s, click('btn'), screenA)).toThrow(expect.objectContaining({ code: 'invalid_layers' }));
  });

  it('a "while pressing" navigation lasts, so it stops the rest of the click', () => {
    const doc = protoDoc([A, B, C], { btn: [on('ON_PRESS', navigate('B')), on('ON_CLICK', navigate('C'))] });
    const { state } = act(doc, start(doc, 'A'), click('btn'), screenA);
    expect(state).toMatchObject({ frameId: 'B', history: ['A'] });
  });

  it('a "while pressing" navigation is not undone at release', () => {
    const doc = protoDoc([A, B], { btn: [on('ON_PRESS', navigate('B'))] });
    const { state, outcome } = act(doc, start(doc, 'A'), click('btn'), screenA);
    expect(outcome).toBe('navigated');
    expect(state.frameId).toBe('B');
  });

  describe('a delayed MOUSE_ENTER', () => {
    const doc = protoDoc([A, P1], { x: [mouse('MOUSE_ENTER', 500, openOverlay('P1'))] });
    const layers = [root, x, y];

    it('waits for settle, and fires there while the pointer is still on the layer', () => {
      const hovered = act(doc, start(doc, 'A'), hover('x'), layers);
      expect(hovered.outcome).toBe('nothing_happened');
      expect(hovered.state.overlays).toEqual([]);
      const settled = settle(doc, hovered.state);
      expect(settled.fired).toBe(1);
      expect(settled.looped).toBeNull();
      expect(settled.state.overlays.map((o) => o.frameId)).toEqual(['P1']);
      expect(settled.state.clockMs).toBe(500);
      expect(settled.state.timers).toEqual([]);
    });

    it('does not fire once the pointer has moved off', () => {
      const hovered = act(doc, start(doc, 'A'), hover('x'), layers).state;
      const away = act(doc, hovered, hover('y'), layers).state;
      const settled = settle(doc, away);
      expect(settled.fired).toBe(0);
      expect(settled.state.overlays).toEqual([]);
      expect(settled.state.timers).toEqual([]);
    });
  });

  it('leaving the frame cancels its pending delayed reactions', () => {
    const doc = protoDoc([A, B, P1], { x: [mouse('MOUSE_ENTER', 500, openOverlay('P1'))], y: [on('ON_CLICK', navigate('B'))] });
    const layers = [root, layer('x', 'A', [0, 0, 300, 300]), layer('y', 'x', [200, 0, 100, 100])];
    const hovered = act(doc, start(doc, 'A'), hover('x'), layers).state;
    expect(hovered.timers).toHaveLength(1);
    const { state } = act(doc, hovered, click('y'), layers);
    expect(state.frameId).toBe('B');
    expect(state.timers).toEqual([]);
  });

  it('a delayed MOUSE_LEAVE fires at settle only while the pointer stays off the layer', () => {
    const doc = protoDoc([A, P1], { x: [mouse('MOUSE_LEAVE', 300, openOverlay('P1'))] });
    const layers = [root, x, y];
    const onX = act(doc, start(doc, 'A'), hover('x'), layers).state;
    const offX = act(doc, onX, hover('y'), layers).state;
    expect(settle(doc, offX).state.overlays.map((o) => o.frameId)).toEqual(['P1']);
    const backOnX = act(doc, offX, hover('x'), layers).state;
    expect(settle(doc, backOnX).fired).toBe(0);
  });

  it('a click moves the pointer first, so a MOUSE_LEAVE that navigates means the press never lands', () => {
    const doc = protoDoc([A, B, C], { x: [mouse('MOUSE_LEAVE', 0, navigate('B'))], y: [on('ON_CLICK', navigate('C'))] });
    const layers = [root, x, y];
    const onX = act(doc, start(doc, 'A'), hover('x'), layers).state;
    const { state } = act(doc, onX, click('y'), layers);
    expect(state.frameId).toBe('B');
    expect(state.history).toEqual(['A']);
    expect(state.pointer.point).toEqual({ x: 250, y: 50 });
  });
});

// --- Scroll -------------------------------------------------------------------------

describe('scroll', () => {
  // A 400x2000 start frame: the viewport is 400x844, the page range 1156, a page step round(0.9 * 844) = 760.
  const tall = (overflowDirection: OverflowDirection = 'NONE') => frame('T', 400, 2000, { overflowDirection });
  const tallRoot = (y = 0) => layer('T', null, [0, -y, 400, 2000]);

  it.each<OverflowDirection>(['NONE', 'HORIZONTAL', 'VERTICAL', 'BOTH'])(
    'a frame taller than the viewport scrolls down with overflowDirection %s',
    (direction) => {
      const doc = protoDoc([tall(direction)]);
      const { state, outcome } = act(doc, start(doc, 'T'), scroll('down'), [tallRoot()]);
      expect(outcome).toBe('scrolled');
      expect(state.scroll.T).toEqual({ x: 0, y: 760, areas: {} });
    },
  );

  it('stops at the end of the range, then gives scroll_at_end', () => {
    const doc = protoDoc([tall()]);
    const once = act(doc, start(doc, 'T'), scroll('down'), [tallRoot()]).state;
    const twice = act(doc, once, scroll('down'), [tallRoot(760)]);
    expect(twice.outcome).toBe('scrolled');
    expect(twice.state.scroll.T?.y).toBe(1156);
    const third = act(doc, twice.state, scroll('down'), [tallRoot(1156)]);
    expect(third.outcome).toBe('scroll_at_end');
    expect(third.state.scroll).toEqual(twice.state.scroll);
  });

  it.each([
    { what: 'up at the top', frames: [tall()], startId: 'T', direction: 'up' as const },
    { what: 'down on a frame that fits the viewport', frames: [A], startId: 'A', direction: 'down' as const },
    { what: 'right on a frame as wide as the viewport', frames: [tall()], startId: 'T', direction: 'right' as const },
  ])('scrolling $what gives scroll_at_end', ({ frames, startId, direction }) => {
    const doc = protoDoc(frames);
    const layers = [layer(startId, null, [0, 0, 400, 800])];
    expect(act(doc, start(doc, startId), scroll(direction), layers).outcome).toBe('scroll_at_end');
  });

  it.each([
    { amount: undefined, y: 760 },
    { amount: 'page' as const, y: 760 },
    { amount: 'half' as const, y: 422 },
  ])('amount $amount moves the page by $y', ({ amount, y }) => {
    const doc = protoDoc([tall()]);
    expect(act(doc, start(doc, 'T'), scroll('down', undefined, amount), [tallRoot()]).state.scroll.T?.y).toBe(y);
  });

  it('a frame wider than the viewport scrolls horizontally', () => {
    const doc = protoDoc([A, frame('W', 800, 800)]);
    const s = start(doc, 'A');
    s.frameId = 'W';
    const { state, outcome } = act(doc, s, scroll('right'), [layer('W', null, [0, 0, 800, 800])]);
    expect(outcome).toBe('scrolled');
    expect(state.scroll.W).toEqual({ x: 360, y: 0, areas: {} });
  });

  describe('a nested scroll area', () => {
    // A horizontal carousel 400 wide, whose content reaches 600 past it (and 300 below, which it can't scroll to).
    const carousel = layer('car', 'T', [0, 100, 400, 200], { scroll: { direction: 'HORIZONTAL', maxX: 600, maxY: 300 } });
    const card = layer('card', 'car', [0, 100, 150, 200]);
    const doc = protoDoc([tall()]);

    it('scrolls along its own axis by a step of its own size', () => {
      const { state, outcome } = act(doc, start(doc, 'T'), scroll('right', 'card'), [tallRoot(), carousel, card]);
      expect(outcome).toBe('scrolled');
      expect(state.scroll.T).toEqual({ x: 0, y: 0, areas: { car: { x: 360, y: 0 } } });
    });

    it('does not move on the other axis: the page scrolls instead', () => {
      const { state } = act(doc, start(doc, 'T'), scroll('down', 'card'), [tallRoot(), carousel, card]);
      expect(state.scroll.T).toEqual({ x: 0, y: 760, areas: {} });
    });

    it('stays put when nothing around it can move on that axis', () => {
      const short = protoDoc([frame('T', 400, 800)]);
      const layers = [layer('T', null, [0, 0, 400, 800]), carousel, card];
      const { state, outcome } = act(short, start(short, 'T'), scroll('down', 'card'), layers);
      expect(outcome).toBe('scroll_at_end');
      expect(state.scroll).toEqual({});
    });

    describe('with an overlay open', () => {
      // A 400x1200 overlay is taller than the 844 high viewport, so it scrolls itself, by up to 356.
      const tallOverlay = overlayFrame('M', 400, 1200, { position: 'TOP_LEFT' });
      const d = protoDoc([tall(), tallOverlay, overlayFrame('S', 200, 100)]);
      const open = (frameId: string): TraceState => {
        const s = start(d, 'T');
        s.overlays = [{ frameId, position: 'TOP_LEFT', origin: { x: 0, y: 0 }, closeOnOutsideClick: false }];
        return s;
      };
      const layers = [tallRoot(), layer('pageItem', 'T', [0, 500, 400, 40]), layer('M', null, [0, 0, 400, 1200]), layer('ok', 'M', [20, 20, 100, 40])];

      it.each([
        { how: 'without an element', element: undefined },
        { how: 'over an element in it', element: 'ok' },
      ])('a scroll $how moves the top overlay, never the page under it', ({ element }) => {
        const { state, outcome } = act(d, open('M'), scroll('down', element), layers);
        expect(outcome).toBe('scrolled');
        expect(state.scroll).toEqual({ M: { x: 0, y: 356, areas: {} } });
      });

      it('a scroll gives scroll_at_end when the top overlay cannot scroll', () => {
        const small = [tallRoot(), layer('S', null, [0, 0, 200, 100])];
        const { state, outcome } = act(d, open('S'), scroll('down'), small);
        expect(outcome).toBe('scroll_at_end');
        expect(state.scroll).toEqual({});
      });

      it('a scroll over an element of the page under the overlay moves nothing', () => {
        const { state, outcome } = act(d, open('M'), scroll('down', 'pageItem'), layers);
        expect(outcome).toBe('scroll_at_end');
        expect(state.scroll).toEqual({});
      });
    });

    it('a scroll over an overlay moves only areas inside it, never the page under it', () => {
      const M = overlayFrame('M', 200, 100);
      const d = protoDoc([tall(), M]);
      const s = start(d, 'T');
      s.overlays = [{ frameId: 'M', position: 'CENTER', origin: { x: 100, y: 372 }, closeOnOutsideClick: false }];
      const layers = [tallRoot(), layer('M', null, [100, 372, 200, 100]), layer('ok', 'M', [120, 380, 60, 30])];
      const { state, outcome } = act(d, s, scroll('down', 'ok'), layers);
      expect(outcome).toBe('scroll_at_end');
      expect(state.scroll).toEqual({});
    });

    it('gives scroll_at_end at the end of its own range', () => {
      const s = start(doc, 'T');
      s.scroll = { T: { x: 0, y: 0, areas: { car: { x: 600, y: 0 } } } };
      expect(act(doc, s, scroll('right', 'card'), [tallRoot(), carousel, card]).outcome).toBe('scroll_at_end');
    });
  });

  describe('SCROLL_TO', () => {
    const doc = protoDoc([tall()], {
      toSection: [on('ON_CLICK', node('SCROLL_TO', 'section'))],
      toItem: [on('ON_CLICK', node('SCROLL_TO', 'item'))],
    });
    const header = layer('header', 'T', [0, 0, 400, 60], { fixed: true });
    const buttons = [layer('toSection', 'header', [0, 0, 100, 60]), layer('toItem', 'header', [200, 0, 100, 60])];

    it('scrolls the page so the node is at the top, within the range', () => {
      const s = start(doc, 'T');
      s.scroll = { T: { x: 0, y: 100, areas: {} } };
      const near = layer('section', 'T', [0, 400, 400, 300]); // content y 500
      const far = layer('section', 'T', [0, 1100, 400, 300]); // content y 1200, past the range
      const first = act(doc, s, click('toSection'), [tallRoot(100), near, header, ...buttons]);
      expect(first.outcome).toBe('scrolled');
      expect(first.state.scroll.T?.y).toBe(500);
      expect(act(doc, s, click('toSection'), [tallRoot(100), far, header, ...buttons]).state.scroll.T?.y).toBe(1156);
    });

    it('scrolls a nested area, then the page, to bring a node inside it into view', () => {
      const list = layer('list', 'T', [0, 200, 400, 300], { scroll: { direction: 'VERTICAL', maxX: 0, maxY: 900 } });
      const item = layer('item', 'list', [0, 500, 400, 0], { unclippedBox: box([0, 800, 400, 50]) });
      const { state } = act(doc, start(doc, 'T'), click('toItem'), [tallRoot(), list, item, header, ...buttons]);
      expect(state.scroll.T).toEqual({ x: 0, y: 200, areas: { list: { x: 0, y: 600 } } });
    });

    it.each([
      { what: 'a fixed child', target: 'bar' },
      { what: 'a node inside a fixed child', target: 'icon' },
    ])('does nothing for $what: it does not move when the page scrolls', ({ target }) => {
      // A bar fixed to the bottom of the 844 high viewport: it is drawn at y = 784 whatever the page offset.
      const d = protoDoc([tall()], { go: [on('ON_CLICK', node('SCROLL_TO', target))] });
      const bar = layer('bar', 'T', [0, 784, 400, 60], { fixed: true });
      const layers = [tallRoot(300), bar, layer('icon', 'bar', [300, 794, 40, 40]), layer('go', 'bar', [0, 784, 100, 60])];
      const s = start(d, 'T');
      s.scroll = { T: { x: 0, y: 300, areas: {} } };
      const { state, outcome } = act(d, s, click('go'), layers);
      expect(outcome).toBe('nothing_happened');
      expect(state.scroll).toEqual(s.scroll);
    });
  });
});

// --- Other outcomes and refusals ------------------------------------------------------

describe('other outcomes', () => {
  it('a URL action leaves the prototype and keeps the screen', () => {
    const doc = protoDoc([A], { btn: [on('ON_CLICK', { type: 'URL', url: 'https://example.com/help' })] });
    const { state, outcome, effects } = act(doc, start(doc, 'A'), click('btn'), screenA);
    expect(outcome).toBe('left_prototype');
    expect(effects).toEqual([{ type: 'url', url: 'https://example.com/help' }]);
    expect(state.frameId).toBe('A');
  });

  it.each([
    { what: 'UPDATE_MEDIA_RUNTIME', action: { type: 'UPDATE_MEDIA_RUNTIME' } as ProtoAction, name: 'UPDATE_MEDIA_RUNTIME' },
    { what: 'an unknown action type', action: { type: 'UNKNOWN', rawType: 'OPEN_APP' } as ProtoAction, name: 'OPEN_APP' },
  ])('$what is unsupported', ({ action, name }) => {
    const doc = protoDoc([A], { btn: [on('ON_CLICK', action)] });
    const { outcome, effects } = act(doc, start(doc, 'A'), click('btn'), screenA);
    expect(outcome).toBe('unsupported');
    expect(effects).toEqual([{ type: 'unsupported', action: name }]);
  });

  it('a visible change wins over an unsupported action in the same reaction', () => {
    const doc = protoDoc([A, B], { btn: [on('ON_CLICK', { type: 'UPDATE_MEDIA_RUNTIME' }, navigate('B'))] });
    const { outcome, effects } = act(doc, start(doc, 'A'), click('btn'), screenA);
    expect(outcome).toBe('navigated');
    expect(effects).toEqual([{ type: 'unsupported', action: 'UPDATE_MEDIA_RUNTIME' }]);
  });

  it('drag fires ON_DRAG, and a click does not', () => {
    const doc = protoDoc([A, B], { btn: [on('ON_DRAG', navigate('B'))] });
    expect(act(doc, start(doc, 'A'), { type: 'drag', element: 'btn' }, screenA).state.frameId).toBe('B');
    expect(act(doc, start(doc, 'A'), click('btn'), screenA).outcome).toBe('nothing_happened');
  });

  it('a click on an unwired layer is a misclick', () => {
    const doc = protoDoc([A]);
    expect(act(doc, start(doc, 'A'), click('btn'), screenA).outcome).toBe('nothing_happened');
  });

  it.each<TraceAction>([
    { type: 'give_up', reason: 'stuck' },
    { type: 'done', claim: 'paid the invoice' },
  ])('refuses $type, which the backend handles', (action) => {
    const doc = protoDoc([A]);
    const run = () => act(doc, start(doc, 'A'), action, screenA);
    expect(run).toThrow(EngineError);
    expect(run).toThrow(expect.objectContaining({ code: 'run_ending_action' }));
  });

  it('refuses an element id that is not on this screen', () => {
    const doc = protoDoc([A]);
    expect(() => act(doc, start(doc, 'A'), click('e99'), screenA)).toThrow(expect.objectContaining({ code: 'unknown_element' }));
  });

  it('refuses a root layer that carries a scroll area: a frame scrolls as a page', () => {
    const doc = protoDoc([frame('T', 400, 2000, { overflowDirection: 'VERTICAL' })]);
    const root = layer('T', null, [0, 0, 400, 2000], { scroll: { direction: 'VERTICAL', maxX: 0, maxY: 600 } });
    expect(() => act(doc, start(doc, 'T'), scroll('down'), [root])).toThrow(expect.objectContaining({ code: 'invalid_layers' }));
  });

  it.each([
    { what: 'apply', run: (doc: ReturnType<typeof protoDoc>, s: TraceState) => act(doc, s, click('btn'), screenA) },
    { what: 'settle', run: (doc: ReturnType<typeof protoDoc>, s: TraceState) => settle(doc, s) },
  ])('$what refuses a state made from another version of the document', ({ run }) => {
    const doc = protoDoc([A]);
    const s = start(doc, 'A');
    expect(() => run({ ...doc, docHash: 'hash-2' }, s)).toThrow(expect.objectContaining({ code: 'doc_changed' }));
  });

  it('refuses measured layers whose parent was not measured', () => {
    const doc = protoDoc([A]);
    const orphan = [layer('A', null, [0, 0, 400, 800]), layer('btn', 'missing', [20, 20, 100, 40])];
    expect(() => act(doc, start(doc, 'A'), click('btn'), orphan)).toThrow(expect.objectContaining({ code: 'invalid_layers' }));
  });
});

// --- Determinism ---------------------------------------------------------------------

describe('determinism', () => {
  const menu = overlayFrame('menu', 200, 300, { position: 'TOP_RIGHT', closeOnOutsideClick: true });
  const doc = protoDoc([frame('T', 400, 2000), menu, B], {
    open: [on('ON_CLICK', openOverlay('menu'))],
    x: [mouse('MOUSE_ENTER', 200, navigate('B'))],
  });
  const base = [layer('T', null, [0, 0, 400, 2000]), layer('open', 'T', [0, 0, 100, 40]), layer('x', 'T', [0, 100, 100, 40])];
  /** The layers a render of the state would measure: the menu's too once it is open. */
  const layersFor = (s: TraceState) => (s.overlays.length ? [...base, layer('menu', null, [200, 0, 200, 300])] : base);
  const layers = base;
  const script: TraceAction[] = [hover('x'), click('open'), scroll('down'), { type: 'back' }];

  function play(state: TraceState): TraceState[] {
    const states = [state];
    for (const action of script) {
      const last = states[states.length - 1] as TraceState;
      states.push(act(doc, last, action, layersFor(last)).state);
    }
    return states;
  }

  it('gives the same states for the same inputs', () => {
    expect(play(start(doc, 'T'))).toEqual(play(start(doc, 'T')));
  });

  it('never mutates the state, the document or the layers it is given', () => {
    const frozenDoc = deepFreeze(structuredClone(doc));
    const frozenLayers = deepFreeze(structuredClone(layers));
    const first = start(doc, 'T');
    const snapshot = structuredClone(first);
    let s = first;
    for (const action of script) {
      const frozen = deepFreeze(structuredClone(s));
      const frozenScreen = deepFreeze(structuredClone(layersFor(s)));
      s = act(frozenDoc, frozen, action, frozenScreen).state;
    }
    const hovered = deepFreeze(act(frozenDoc, first, hover('x'), frozenLayers).state);
    expect(() => settle(frozenDoc, hovered)).not.toThrow();
    expect(first).toEqual(snapshot);
    expect(frozenDoc).toEqual(doc);
  });

  it('settle with nothing pending fires nothing and keeps the state', () => {
    const s = start(doc, 'T');
    expect(settle(doc, s)).toEqual({ state: s, fired: 0, looped: null, effects: [] });
  });
});
