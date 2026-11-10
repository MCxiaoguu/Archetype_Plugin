import { describe, expect, it } from 'vitest';
import { listElements } from '../src/lib/proto/elements';
import { apply, start } from '../src/lib/proto/engine';
import type { RawLayer, TraceState } from '../src/lib/proto/model';
import { A, B, box, layer, navigate, on, overlayFrame, protoDoc } from './trace-fixtures';

/** The 400x800 frame A, whose size is the viewport. */
const root = layer('A', null, [0, 0, 400, 800]);
const s: TraceState = start(protoDoc([A]), 'A');

type Rect = [number, number, number, number];
const text = (key: string, parentKey: string, rect: Rect, content: string, extra: Partial<RawLayer> = {}) =>
  layer(key, parentKey, rect, { type: 'TEXT', name: content, text: content, ...extra });
const instance = (key: string, parentKey: string, rect: Rect, extra: Partial<RawLayer> = {}) =>
  layer(key, parentKey, rect, { type: 'INSTANCE', ...extra });

const list = (layers: RawLayer[], state = s) => listElements(layers, state);
const labels = (layers: RawLayer[], state = s) => list(layers, state).elements.map((e) => e.label);

describe('listElements', () => {
  it('lists what is inside the viewport, in reading order, with ids e1 on', () => {
    const layers = [
      root,
      text('low', 'A', [20, 500, 100, 20], 'Low'),
      text('left', 'A', [20, 100, 100, 20], 'Left'),
      text('right', 'A', [200, 100, 100, 20], 'Right'),
      text('fold', 'A', [20, 780, 100, 40], 'At the fold'),
      text('below', 'A', [20, 900, 100, 20], 'Below the fold'),
      text('aside', 'A', [420, 100, 100, 20], 'Off to the side'),
    ];
    const { elements } = list(layers);
    expect(elements.map((e) => [e.id, e.label])).toEqual([
      ['e1', 'Left'],
      ['e2', 'Right'],
      ['e3', 'Low'],
      ['e4', 'At the fold'],
    ]);
    // Cut to the part inside the viewport.
    expect(elements[3]?.box).toEqual([20, 780, 100, 20]);
  });

  it.each<{ what: string; layers: RawLayer[]; expected: Array<[string, string]> }>([
    { what: 'plain text is text', layers: [text('t', 'A', [20, 20, 200, 20], 'Your invoices')], expected: [['text', 'Your invoices']] },
    {
      what: 'text with a reaction is a link',
      layers: [text('t', 'A', [20, 20, 200, 20], 'Forgot password?', { hasReactions: true })],
      expected: [['link', 'Forgot password?']],
    },
    {
      what: 'text that looks like a link is a link',
      layers: [text('t', 'A', [20, 20, 200, 20], 'Terms', { roleHint: 'link' })],
      expected: [['link', 'Terms']],
    },
    {
      what: 'an instance with a label is a button named by its text',
      layers: [instance('b', 'A', [20, 20, 120, 44], { name: 'Button' }), text('bt', 'b', [30, 30, 100, 20], 'Continue')],
      expected: [['button', 'Continue']],
    },
    {
      what: 'a filled frame with one label is a button',
      layers: [layer('f', 'A', [20, 20, 120, 44], { name: 'Frame 12' }), text('ft', 'f', [30, 30, 100, 20], 'Pay now')],
      expected: [['button', 'Pay now']],
    },
    {
      what: 'a filled panel of text is not a control: its texts are listed',
      layers: [
        layer('panel', 'A', [0, 0, 400, 300], { name: 'Frame 3' }),
        text('h', 'panel', [20, 20, 300, 30], 'Billing'),
        text('p', 'panel', [20, 60, 300, 40], 'Your plan renews monthly.'),
      ],
      expected: [
        ['text', 'Billing'],
        ['text', 'Your plan renews monthly.'],
      ],
    },
    {
      what: 'an instance holding several texts is a card named by the first, its texts listed too',
      layers: [
        instance('c', 'A', [20, 20, 300, 100], { name: 'Plan card' }),
        text('c1', 'c', [30, 30, 200, 20], 'Pro'),
        text('c2', 'c', [30, 60, 200, 20], '$12 a month'),
      ],
      expected: [
        ['card', 'Pro'],
        ['text', 'Pro'],
        ['text', '$12 a month'],
      ],
    },
    { what: 'an icon keeps its role', layers: [instance('i', 'A', [20, 20, 24, 24], { name: 'icons8-help-32 1', roleHint: 'icon' })], expected: [['icon', 'icon']] },
    { what: 'an image keeps its role', layers: [layer('img', 'A', [20, 20, 300, 200], { name: 'image 4', roleHint: 'image' })], expected: [['image', 'image']] },
    {
      what: 'an input keeps its role and is named by its placeholder',
      layers: [instance('in', 'A', [20, 20, 300, 44], { roleHint: 'input' }), text('ph', 'in', [30, 30, 200, 20], 'Email address')],
      expected: [['input', 'Email address']],
    },
  ])('$what', ({ layers, expected }) => {
    expect(list([root, ...layers]).elements.map((e) => [e.role, e.label])).toEqual(expected);
  });

  describe('labels', () => {
    it.each(['Rectangle 12', 'Frame 48', 'icons8-help-32 1', 'image 4', 'Group', 'Vector 2', 'IMG_2034', 'photo-1534528741775-53994a69daeb 1', 'Screenshot 2024-01-01 at 10.00.00', 'logo.png', 'State=Default, Size=Large', '12'])(
      'never use the generic name "%s": the text inside, otherwise the role word',
      (name) => {
        const withText = [root, instance('b', 'A', [20, 20, 120, 44], { name }), text('bt', 'b', [30, 30, 100, 20], 'Save')];
        expect(labels(withText)).toEqual(['Save']);
        expect(labels([root, instance('b', 'A', [20, 20, 120, 44], { name })])).toEqual(['button']);
      },
    );

    it.each([
      { name: 'Close', label: 'Close' },
      { name: 'Sign in', label: 'Sign in' },
      { name: 'icon/arrow-right', label: 'arrow right' },
      { name: 'nav_settings', label: 'nav settings' },
    ])('use a readable name: "$name" reads "$label"', ({ name, label }) => {
      expect(labels([root, instance('b', 'A', [20, 20, 40, 40], { name })])).toEqual([label]);
    });

    it('collapse white space and cut long text', () => {
      const long = `Read  me\n${'x'.repeat(300)}`;
      const [label] = labels([root, text('t', 'A', [20, 20, 300, 200], long)]);
      expect(label?.startsWith('Read me x')).toBe(true);
      expect(label?.length).toBeLessThanOrEqual(120);
      expect(label?.endsWith('…')).toBe(true);
    });
  });

  describe('invisible layers with reactions', () => {
    const hotspot = (name: string) => layer('hot', 'A', [50, 50, 100, 40], { type: 'RECTANGLE', name, paints: false, hasReactions: true });

    it('are an "unlabeled area"', () => {
      expect(list([root, layer('shot', 'A', [0, 0, 400, 800], { roleHint: 'image', name: 'Screenshot 1' }), hotspot('Rectangle 3')]).elements).toEqual([
        { id: 'e1', label: 'image', role: 'image', box: [0, 0, 400, 800] },
        { id: 'e2', label: 'unlabeled area', role: 'button', box: [50, 50, 100, 40] },
      ]);
    });

    it('can be clicked through the targets apply takes', () => {
      const doc = protoDoc([A, B], { hot: [on('ON_CLICK', navigate('B'))] });
      const layers = [root, layer('shot', 'A', [0, 0, 400, 800], { roleHint: 'image', name: 'Screenshot 1' }), hotspot('Rectangle 3')];
      const { elements, targets } = listElements(layers, start(doc, 'A'));
      const area = elements.find((e) => e.label === 'unlabeled area');
      const { outcome } = apply(doc, start(doc, 'A'), { type: 'click', element: area?.id ?? 'missing' }, layers, targets);
      expect(outcome).toBe('navigated');
    });

    it('take a readable name', () => {
      expect(labels([root, hotspot('Pay now')])).toEqual(['Pay now']);
    });

    it('are left out when they carry no reaction either', () => {
      expect(labels([root, layer('ghost', 'A', [50, 50, 100, 40], { paints: false })])).toEqual([]);
    });
  });

  it('lists unwired controls like wired ones, and shows nothing of the wiring', () => {
    const layers = [
      root,
      instance('wired', 'A', [20, 20, 120, 44], { hasReactions: true }),
      text('wt', 'wired', [30, 30, 100, 20], 'Save'),
      instance('dead', 'A', [20, 100, 120, 44]),
      text('dt', 'dead', [30, 110, 100, 20], 'Cancel'),
    ];
    const { elements } = list(layers);
    expect(elements).toEqual([
      { id: 'e1', label: 'Save', role: 'button', box: [20, 20, 120, 44] },
      { id: 'e2', label: 'Cancel', role: 'button', box: [20, 100, 120, 44] },
    ]);
    expect(JSON.stringify(elements)).not.toMatch(/wired|dead|reaction/);
  });

  it('leaves out hidden layers, layers in hidden groups, and the frame itself', () => {
    const layers = [
      root,
      text('hidden', 'A', [20, 20, 100, 20], 'Hidden', { visible: false }),
      layer('group', 'A', [0, 100, 400, 100], { visible: false }),
      text('inside', 'group', [20, 120, 100, 20], 'Inside a hidden group'),
      text('shown', 'A', [20, 300, 100, 20], 'Shown'),
    ];
    expect(labels(layers)).toEqual(['Shown']);
  });

  it('leaves out what an open overlay covers, and lists the overlay', () => {
    const doc = protoDoc([A, overlayFrame('M', 200, 200)]);
    const state = { ...start(doc, 'A'), overlays: [{ frameId: 'M', position: 'CENTER' as const, origin: { x: 100, y: 300 }, closeOnOutsideClick: false }] };
    const layers = [
      root,
      text('under', 'A', [120, 320, 100, 20], 'Covered'),
      text('beside', 'A', [20, 20, 100, 20], 'Beside'),
      layer('M', null, [100, 300, 200, 200]),
      instance('ok', 'M', [120, 440, 160, 40]),
      text('okt', 'ok', [130, 450, 100, 20], 'Got it'),
    ];
    expect(labels(layers, state)).toEqual(['Beside', 'Got it']);
  });

  it("an element's click point is the centre of its visible box", () => {
    // A row the list clips at y = 400, and a button cut by the bottom of the viewport.
    const layers = [
      root,
      layer('list', 'A', [0, 400, 400, 200], { name: 'Frame 1', paints: false }),
      instance('row', 'list', [0, 400, 400, 40], { name: 'Row', unclippedBox: box([0, 380, 400, 60]) }),
      instance('cta', 'A', [100, 760, 200, 80], { name: 'Checkout' }),
    ];
    const { elements, targets } = list(layers);
    expect(elements.map((e) => e.label)).toEqual(['Row', 'Checkout']);
    expect(targets).toEqual({
      e1: { layerKey: 'row', point: { x: 200, y: 420 } },
      e2: { layerKey: 'cta', point: { x: 200, y: 780 } },
    });
  });

  describe('the cap of 80', () => {
    const buttons = (n: number, size = (i: number) => 20 + i) =>
      Array.from({ length: n }, (_, i) => instance(`b${i}`, 'A', [(i % 10) * 40, Math.floor(i / 10) * 30, size(i), 20], { name: `Item ${i}` }));
    const texts = (n: number) =>
      Array.from({ length: n }, (_, i) => text(`t${i}`, 'A', [(i % 10) * 40, 400 + Math.floor(i / 10) * 30, 10 + i, 20], `Note ${i}`));

    it('trims text blocks first, the smallest first', () => {
      const { elements } = list([root, ...buttons(70), ...texts(30)]);
      expect(elements).toHaveLength(80);
      expect(elements.filter((e) => e.role === 'button')).toHaveLength(70);
      expect(elements.filter((e) => e.role === 'text').map((e) => e.label)).toEqual(texts(30).slice(20).map((t) => t.text));
    });

    it('then trims the smallest elements', () => {
      const { elements, targets } = list([root, ...buttons(90)]);
      expect(elements).toHaveLength(80);
      expect(elements.map((e) => e.label)).not.toContain('Item 0');
      expect(elements.map((e) => e.label)).toContain('Item 10');
      expect(elements.map((e) => e.id)).toEqual(Array.from({ length: 80 }, (_, i) => `e${i + 1}`));
      expect(Object.keys(targets)).toHaveLength(80);
    });
  });
});
