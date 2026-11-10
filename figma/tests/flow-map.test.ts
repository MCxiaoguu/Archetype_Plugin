import { describe, expect, it } from 'vitest';
import fixtureJson from '../harness/fixtures/farside-proto.json';
import { start } from '../src/lib/proto/engine';
import { candidatesOf, type FlowCandidate } from '../src/lib/proto/flow';
import type { ProtoDoc } from '../src/lib/proto/model';
import { isInside } from '../src/lib/proto/variants';
import { readFlow } from '../src/main/flowMap';
import { readProtoWithKeys } from '../src/main/protoReader';
import { createRenderer } from '../src/main/renderer';
import { exclusive } from '../src/main/scratch';
import { fakeFromFixture, type ProtoFixture } from './fake-figma';

interface Spec {
  id: string;
  children?: Spec[];
  [field: string]: unknown;
}

const INK = [{ type: 'SOLID', color: { r: 0.1, g: 0.1, b: 0.12 }, opacity: 1, visible: true }];
const text = (id: string, characters: string, extra: Record<string, unknown> = {}): Spec => ({
  id,
  name: characters,
  type: 'TEXT',
  x: 0,
  y: 0,
  width: 160,
  height: 20,
  characters,
  fontName: { family: 'Inter', style: 'Regular' },
  fills: INK,
  ...extra,
});

/**
 * The fake Farside page, with unwired elements where the renderer keys
 * layers its own ways: inside a variant (`2:33;8:7`) and inside a variant
 * of an instance inside a variant (`2:33;8:6;6:15`); and on the Dashboard
 * a hidden text, a seven word line and a line break.
 */
function fixture(): ProtoFixture {
  const json = structuredClone(fixtureJson) as unknown as { pages: Spec[] };
  const added: Record<string, Spec[]> = {
    '8:4': [
      {
        id: '8:7',
        name: 'Hint',
        type: 'FRAME',
        x: 0,
        y: 30,
        width: 160,
        height: 24,
        fills: [{ type: 'SOLID', color: { r: 0.9, g: 0.9, b: 0.95 }, opacity: 1, visible: true }],
        children: [text('8:8', 'On for this device')],
      },
    ],
    '6:13': [text('6:15', 'Saved just now', { x: 0, y: 22 })],
    '1:2': [
      text('1:12', 'See what changed since your last visit', { x: 280, y: 400, width: 400 }),
      text('1:13', 'Beta', { x: 280, y: 440, visible: false }),
      text('1:14', 'Monthly\nstatement', { x: 280, y: 480, height: 40 }),
    ],
  };
  const walk = (n: Spec) => {
    if (added[n.id]) n.children = [...(n.children ?? []), ...(added[n.id] as Spec[])];
    for (const c of n.children ?? []) walk(c);
  };
  json.pages.forEach(walk);
  return json as unknown as ProtoFixture;
}

async function setup() {
  const fake = fakeFromFixture(fixture());
  const { doc, frameOf } = await readProtoWithKeys(fake.api, fake.api.currentPage, { importLibraryVariants: true });
  const flow = await exclusive(fake.api, () => readFlow(fake.api, doc, frameOf));
  return { ...fake, doc, flow };
}

const of = (candidates: FlowCandidate[], node: string, layerKey: string) => candidates.find((c) => c.node === node && c.layerKey === layerKey);

/**
 * What the same rules list from the renderer's own measured layers: the
 * frame as it starts, and each variant of each interactive component in it
 * (those inside a variant with that variant shown).
 */
async function renderedCandidates(api: PluginAPI, doc: ProtoDoc, frameId: string): Promise<Set<string>> {
  const renderer = createRenderer(api);
  const render = async (overrides: Record<string, string>) => {
    const s = { ...start(doc, frameId), variants: Object.keys(overrides).length ? { [frameId]: overrides } : {} };
    return (await renderer.render(doc, s)).layers;
  };
  const keys = new Set<string>();
  const base = await render({});
  for (const c of candidatesOf(frameId, base, () => '')) keys.add(c.layerKey);
  const scenes = [{ overrides: {} as Record<string, string>, keys: new Set(base.map((l) => l.key)) }];
  const sets = Object.entries(doc.variantSets)
    .filter(([, set]) => set.frameId === frameId)
    .sort(([a], [b]) => a.length - b.length);
  for (const [instanceKey, set] of sets) {
    const at = scenes.find((sc) => sc.keys.has(instanceKey));
    if (!at) continue;
    // A variant that couldn't be imported can't be shown.
    for (const variant of set.variants.filter((v) => v.componentId)) {
      const overrides = { ...at.overrides, [instanceKey]: variant.id };
      const layers = await render(overrides);
      for (const c of candidatesOf(frameId, layers, () => '')) if (c.layerKey === instanceKey || isInside(instanceKey, c.layerKey)) keys.add(c.layerKey);
      scenes.push({ overrides, keys: new Set(layers.map((l) => l.key)) });
    }
  }
  return keys;
}

describe('flow map candidates', () => {
  it("are keyed as the renderer measures them, in every frame and every variant of the frames' components", async () => {
    const t = await setup();
    for (const frame of t.doc.frames) {
      const listed = new Set(t.flow.candidates.filter((c) => c.node === frame.id).map((c) => c.layerKey));
      expect([...listed].sort(), frame.name).toEqual([...(await renderedCandidates(t.api, t.doc, frame.id))].sort());
    }
    // Inside a variant, and inside a variant of an instance inside a variant.
    expect(of(t.flow.candidates, '2:30', '2:33;8:7')).toMatchObject({ label: 'On for this device', role: 'button', shareKey: 'C:8:4;8:7' });
    expect(of(t.flow.candidates, '2:30', '2:33;8:6;6:15')).toMatchObject({ label: 'Saved just now', role: 'text', shareKey: 'C:6:13;6:15' });
    // Inside an instance showing its main component.
    expect(of(t.flow.candidates, '3:5', 'I3:8;6:22')).toMatchObject({ label: 'Monthly', role: 'button', shareKey: 'C:6:20;6:22' });
  });

  it('list hidden layers, and leave out a seven word line, a line break and anything with a reaction of its own', async () => {
    const t = await setup();
    const dashboard = t.flow.candidates.filter((c) => c.node === '1:2').map((c) => c.label);
    expect(dashboard).toEqual(['Welcome back, Mara', 'Beta']);
    // Billing, Rectangle 12, What's new and Dark mode are wired; so is Frame 48, but not the text inside it.
    expect(of(t.flow.candidates, '2:20', '2:27')).toMatchObject({ label: 'Use routing number instead', role: 'text', shareKey: 'L:2:20:2:27' });
    expect(of(t.flow.candidates, '2:20', '2:21')).toBeUndefined();
    expect(of(t.flow.candidates, '2:20', '2:22')).toBeUndefined();
    // The spinner inside every button is hidden, and still read: once, under one share key, wherever the button is.
    const spinners = t.flow.candidates.filter((c) => c.label === 'Spinner');
    expect(new Set(spinners.map((c) => c.node)).size).toBeGreaterThan(3);
    expect(new Set(spinners.map((c) => c.shareKey))).toEqual(new Set(['C:6:2;6:4']));
  });

  it('carry their box in frame coordinates, unscrolled, and the visible text nearest to them', async () => {
    const t = await setup();
    // The routing link sits below the fold of the 900 pixel high viewport's list.
    expect(of(t.flow.candidates, '2:20', '2:69')).toMatchObject({ label: 'Ally', role: 'button', box: [40, 880, 600, 80] });
    const routing = of(t.flow.candidates, '2:20', '2:27') as FlowCandidate;
    expect(routing.box).toEqual([40, 680, 320, 24]);
    expect(routing.nearText.split(' · ').slice(0, 2)).toEqual(['PNC', 'Sign in with your bank']);
    expect(routing.nearText.length).toBeLessThanOrEqual(200);
    // Its own label is not its near text.
    expect(of(t.flow.candidates, '2:20', '2:60')?.nearText).not.toContain('Chase');
  });
});

describe('flow map nodes and edges', () => {
  it("name each frame with its largest visible text as heading, and its visible text", async () => {
    const t = await setup();
    expect(t.flow.nodes.find((n) => n.id === '2:20')).toMatchObject({ kind: 'frame', name: 'Connect bank', heading: 'Connect your bank' });
    expect(t.flow.nodes.find((n) => n.id === '1:2')?.text).toBe(
      "Welcome back, Mara · Dark mode · Billing · What's new · See what changed since your last visit · Monthly statement",
    );
    // A frame that shows no text has an empty heading.
    expect(t.flow.nodes.find((n) => n.id === '7:5')).toMatchObject({ heading: '', text: '' });
    expect(t.flow.nodes.map((n) => n.id)).toEqual(t.doc.frames.map((f) => f.id));
  });

  it('mark as overlays the frames reached only as overlays', async () => {
    const t = await setup();
    const kinds = Object.fromEntries(t.flow.nodes.map((n) => [n.id, n.kind]));
    expect(kinds).toMatchObject({ '3:1': 'overlay', '3:3': 'overlay', '2:20': 'frame', '1:2': 'frame' });
  });

  it('list every drawn connection that changes the screen, the variants\' and conditional branches included', async () => {
    const t = await setup();
    const edges = t.flow.edges.map((e) => `${e.from} ${e.layerKey} ${e.trigger} ${e.to} ${e.label}`);
    expect(edges).toEqual(
      expect.arrayContaining([
        '1:2 1:7 ON_CLICK 2:10 Billing',
        // Both branches of the conditional.
        '2:10 2:11 ON_CLICK 2:50 Connect a bank',
        '2:10 2:11 ON_CLICK 2:20 Connect a bank',
        '2:20 2:21 ON_CLICK 3:1 Sign in with your bank',
        '2:30 2:30 ON_KEY_DOWN 2:50 Verify phone',
        // In a variant, and in a variant of an instance inside a variant.
        '2:30 2:33;8:5 ON_HOVER 3:3 Knob',
        '2:30 2:33;8:6;6:14 ON_CLICK 7:5 Saved',
      ]),
    );
    // A connection without a destination, a CHANGE_TO and BACK are no edges.
    expect(t.flow.edges.some((e) => e.layerKey === '2:23' || e.layerKey === '2:33' || e.layerKey === '2:32')).toBe(false);
    expect(t.flow.edges.map((e) => e.id)).toEqual(t.flow.edges.map((_, i) => `d${i + 1}`));
    expect(new Set(t.flow.edges.map((e) => e.by))).toEqual(new Set(['designer']));
  });
});
