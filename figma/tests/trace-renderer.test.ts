import { describe, expect, it } from 'vitest';
import fixtureJson from '../harness/fixtures/farside-proto.json';
import { listElements } from '../src/lib/proto/elements';
import { apply, start } from '../src/lib/proto/engine';
import { activeMode } from '../src/lib/proto/expr';
import type { OpenOverlay, ProtoDoc, RawLayer, TraceState, VariableCollection } from '../src/lib/proto/model';
import { readProto } from '../src/main/protoReader';
import { createRenderer } from '../src/main/renderer';
import { SCRATCH_KEY, SCRATCH_VALUE, scratchNodeIds } from '../src/main/scratch';
import { FakeNode, fakeFromFixture, type ProtoFixture } from './fake-figma';

const COLL = 'VariableCollectionId:10:0';
const LIGHT = '10:0';
const DARK = '10:1';

type Fake = ReturnType<typeof fakeFromFixture>;

async function setup(edit: (fake: Fake) => void = () => {}) {
  const fake = fakeFromFixture(structuredClone(fixtureJson) as unknown as ProtoFixture);
  edit(fake);
  const doc = await readProto(fake.api, fake.api.currentPage, { importLibraryVariants: true });
  fake.world.log = [];
  return { ...fake, doc, renderer: createRenderer(fake.api) };
}

const state = (doc: ProtoDoc, frameId: string, changes: Partial<TraceState> = {}): TraceState => ({ ...start(doc, frameId), ...changes });
const node = (fake: Fake, id: string) => fake.nodes.get(id) as FakeNode;
const layerOf = (layers: RawLayer[], key: string) => {
  const found = layers.find((l) => l.key === key);
  if (!found) throw new Error(`No layer ${key} was measured`);
  return found;
};

interface Drawn {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  characters?: string;
  opacity?: number;
  fills?: Array<{ color?: { r: number; g: number; b: number }; opacity?: number; boundVariables?: unknown }>;
  explicitVariableModes?: Record<string, string>;
  children?: Drawn[];
}

/** The fake export encodes what was drawn: the container with its copies. */
const drawn = (image: Uint8Array) => JSON.parse(new TextDecoder().decode(image)) as Drawn;

function find(tree: Drawn, name: string): Drawn {
  const walk = (n: Drawn): Drawn | null => (n.name === name ? n : (n.children ?? []).map(walk).find(Boolean) ?? null);
  const found = walk(tree);
  if (!found) throw new Error(`Nothing named ${name} was drawn`);
  return found;
}

describe('render', () => {
  describe('the scratch container', () => {
    it('is made off canvas, locked and marked, holds the copies, and is removed after', async () => {
      const fake = await setup();
      const { image } = await fake.renderer.render(fake.doc, state(fake.doc, '2:20'));
      const container = drawn(image);
      expect(container).toMatchObject({ x: -100000, y: 0, width: 1280, height: 900 });
      expect(container.children?.map((c) => c.name)).toEqual(['Connect bank']);
      const made = fake.api.createFrame.mock.results[0]?.value as FakeNode;
      expect(made.locked).toBe(true);
      expect(made.getPluginData(SCRATCH_KEY)).toBe(SCRATCH_VALUE);
      expect(made.removed).toBe(true);
      expect((fake.pages[0] as FakeNode).children.map((c) => c.id)).not.toContain(made.id);
      expect(scratchNodeIds().has(made.id)).toBe(true);
    });

    it('is removed also when the export throws, committing nothing to the undo history', async () => {
      const fake = await setup();
      fake.world.exportFails = 'throw';
      await expect(fake.renderer.render(fake.doc, state(fake.doc, '2:20'))).rejects.toThrow('Export failed');
      const made = fake.api.createFrame.mock.results[0]?.value as FakeNode;
      expect(made.removed).toBe(true);
      // Made and removed in one go, a render changes nothing in the file, so it commits nothing.
      expect(fake.api.commitUndo).not.toHaveBeenCalled();
    });

    it('fills the container with the page\'s prototype background', async () => {
      const fake = await setup();
      const { image } = await fake.renderer.render(fake.doc, state(fake.doc, '2:20'));
      expect(drawn(image).fills).toEqual((fake.pages[0] as FakeNode).prototypeBackgrounds);
    });

    it('records the copies, backdrops and detached frames for the change watchers, not only the container', async () => {
      const fake = await setup();
      const error: OpenOverlay = { frameId: '3:1', position: 'CENTER', origin: { x: 400, y: 330 }, closeOnOutsideClick: true };
      await fake.renderer.render(fake.doc, state(fake.doc, '2:20', { overlays: [error] }));
      await fake.renderer.render(fake.doc, state(fake.doc, '4:5', { scroll: { '4:5': { x: 0, y: 100, areas: {} } } }));
      const made = (fake.world.log as string[]).filter((l) => /^(create|clone) /.test(l)).map((l) => l.split(' ')[1] as string);
      // Two containers, a backdrop, three copies.
      expect(made).toHaveLength(6);
      for (const id of made) expect(scratchNodeIds().has(id)).toBe(true);
      const detached = (fake.world.log as string[]).filter((l) => l.startsWith('detach ')).map((l) => l.split(' ')[2] as string);
      expect(detached).toHaveLength(1);
      expect(scratchNodeIds().has(detached[0] as string)).toBe(true);
    });

    it('refuses a frame open twice on one screen: its layers would share keys', async () => {
      const fake = await setup();
      const twice: OpenOverlay = { frameId: '2:20', position: 'CENTER', origin: { x: 0, y: 0 }, closeOnOutsideClick: false };
      await expect(fake.renderer.render(fake.doc, state(fake.doc, '2:20', { overlays: [twice] }))).rejects.toThrow(/2:20.*twice/);
    });

    it("refuses a screenshot larger than a turn can carry, saying how large", async () => {
      const fake = await setup();
      fake.world.exportFails = 'huge';
      await expect(fake.renderer.render(fake.doc, state(fake.doc, '2:20'))).rejects.toThrow(/1677722 bytes.*1\.5 MiB/);
    });

    it('never runs at the same time as a read: they share one queue', async () => {
      const fake = await setup();
      let open = (): void => {};
      const gate = new Promise<void>((resolve) => (open = resolve));
      const real = fake.api.variables.getLocalVariableCollectionsAsync.getMockImplementation();
      if (!real) throw new Error('The fake has no variables to read');
      fake.api.variables.getLocalVariableCollectionsAsync.mockImplementationOnce(async () => {
        await gate;
        return real();
      });
      const reading = readProto(fake.api, fake.api.currentPage, { importLibraryVariants: true });
      const rendering = fake.renderer.render(fake.doc, state(fake.doc, '2:20'));
      await new Promise((r) => setTimeout(r, 10));
      expect(fake.api.createFrame).not.toHaveBeenCalled();
      open();
      await Promise.all([reading, rendering]);
      expect(fake.api.createFrame).toHaveBeenCalledTimes(1);
      expect(fake.api.skipInvisibleInstanceChildren).toBe(true);
    });

    it('refuses an empty export', async () => {
      const fake = await setup();
      fake.world.exportFails = 'empty';
      await expect(fake.renderer.render(fake.doc, state(fake.doc, '2:20'))).rejects.toThrow(/empty/);
    });

    it('refuses a frame that is no longer in the file, and still removes the container', async () => {
      const fake = await setup();
      node(fake, '2:20').remove();
      await expect(fake.renderer.render(fake.doc, state(fake.doc, '2:20'))).rejects.toThrow(/2:20/);
      expect((fake.api.createFrame.mock.results[0]?.value as FakeNode).removed).toBe(true);
    });

    it('exports the container, the viewport only, as JPEG at 1x, with every instance child reachable', async () => {
      const fake = await setup();
      await fake.renderer.render(fake.doc, state(fake.doc, '2:20'));
      const made = fake.api.createFrame.mock.results[0]?.value as FakeNode;
      expect(fake.world.log).toContain(`export ${made.id} ${JSON.stringify({ format: 'JPG', constraint: { type: 'SCALE', value: 1 } })} skipInvisible=false`);
      expect(fake.api.skipInvisibleInstanceChildren).toBe(true);
    });

    it('renders one state at a time', async () => {
      const fake = await setup();
      await Promise.all([fake.renderer.render(fake.doc, state(fake.doc, '2:20')), fake.renderer.render(fake.doc, state(fake.doc, '1:2'))]);
      const containers = fake.api.createFrame.mock.results.map((r) => (r.value as FakeNode).id);
      const log = (fake.world.log as string[]).filter((l) => containers.some((id) => l === `create ${id}` || l === `remove ${id}`));
      expect(log).toEqual([`create ${containers[0]}`, `remove ${containers[0]}`, `create ${containers[1]}`, `remove ${containers[1]}`]);
      expect(fake.api.commitUndo).not.toHaveBeenCalled();
    });

    it('never changes the originals', async () => {
      const fake = await setup();
      const before = JSON.stringify([node(fake, '2:20').drawn(), node(fake, '2:30').drawn(), node(fake, '1:2').drawn()]);
      const s = state(fake.doc, '2:20', {
        scroll: { '2:20': { x: 0, y: 300, areas: { '2:25': { x: 0, y: 160 } } } },
        variants: { '2:30': { '2:33': '8:4' } },
        variables: { [COLL]: { [LIGHT]: { 'VariableID:10:3': { r: 1, g: 0, b: 0, a: 1 } } } },
      });
      await fake.renderer.render(fake.doc, s);
      await fake.renderer.render(fake.doc, { ...s, frameId: '2:30' });
      expect(JSON.stringify([node(fake, '2:20').drawn(), node(fake, '2:30').drawn(), node(fake, '1:2').drawn()])).toBe(before);
    });
  });

  describe('overlays', () => {
    const error: OpenOverlay = { frameId: '3:1', position: 'CENTER', origin: { x: 400, y: 330 }, closeOnOutsideClick: true };
    const tooltip: OpenOverlay = { frameId: '3:3', position: 'MANUAL', origin: { x: 300, y: 244 }, closeOnOutsideClick: false };

    it('draws a scrolled overlay moved up by its offset, its fixed children staying put', async () => {
      const fake = await setup((f) => {
        node(f, '3:1').height = 1200;
        node(f, '3:1').numberOfFixedChildren = 1;
      });
      const s = state(fake.doc, '2:20', { overlays: [{ ...error, origin: { x: 400, y: 0 } }], scroll: { '3:1': { x: 0, y: 100, areas: {} } } });
      const { image, layers } = await fake.renderer.render(fake.doc, s);
      expect(drawn(image).children?.[2]).toMatchObject({ name: 'Bank sign in error', x: 400, y: -100 });
      // "Try again" is the overlay's last child, so its fixed one.
      expect(layerOf(layers, '3:2')).toMatchObject({ fixed: true, box: { x: 424, y: 168, width: 160, height: 48 } });
      expect(layerOf(layers, '3:4').box.y).toBe(-76);
    });

    it('copies each open overlay at its origin, over a backdrop when it has one', async () => {
      const fake = await setup();
      const { image, layers } = await fake.renderer.render(fake.doc, state(fake.doc, '2:20', { overlays: [error, tooltip] }));
      const children = drawn(image).children ?? [];
      expect(children.map((c) => [c.name, c.x, c.y])).toEqual([
        ['Connect bank', 0, 0],
        ['Rectangle', 0, 0],
        ['Bank sign in error', 400, 330],
        ['ACH tooltip', 300, 244],
      ]);
      expect(children[1]).toMatchObject({ width: 1280, height: 900, fills: [{ color: { r: 0, g: 0, b: 0 }, opacity: 0.4 }] });
      expect(layerOf(layers, '3:1').scroll).toBeNull();
      // The backdrop is the renderer's, not a layer of the prototype.
      expect(layers.filter((l) => l.parentKey === null).map((l) => l.key)).toEqual(['2:20', '3:1', '3:3']);
      expect(layerOf(layers, '3:1').box).toEqual({ x: 400, y: 330, width: 480, height: 240 });
    });
  });

  describe('state on the copies', () => {
    it('shows the override variant, and keys its layers by path under the instance', async () => {
      const fake = await setup();
      const { image, layers } = await fake.renderer.render(fake.doc, state(fake.doc, '2:30', { variants: { '2:30': { '2:33': '8:4' } } }));
      expect(find(drawn(image), 'Knob').x).toBe(26);
      expect(layers.filter((l) => l.parentKey === '2:33').map((l) => l.key)).toEqual(['2:33;8:5', '2:33;8:6']);
      expect(layerOf(layers, '2:33;8:6;6:12')).toMatchObject({ parentKey: '2:33;8:6', text: 'Saved' });
      // The new variant's reactions are what hasReactions reads.
      expect(layerOf(layers, '2:33;8:5').hasReactions).toBe(true);
    });

    it('shows a nested override inside a swapped instance', async () => {
      const fake = await setup();
      const s = state(fake.doc, '2:30', { variants: { '2:30': { '2:33': '8:4', '2:33;8:6': '6:13' } } });
      const { layers } = await fake.renderer.render(fake.doc, s);
      expect(layers.filter((l) => l.parentKey === '2:33;8:6').map((l) => l.key)).toEqual(['2:33;8:6;6:14']);
    });

    it('swaps to a library variant the file holds, in place', async () => {
      const fake = await setup();
      const { layers } = await fake.renderer.render(fake.doc, state(fake.doc, '3:5', { variants: { '3:5': { '3:6': '9:2' } } }));
      expect(fake.world.log?.some((l) => /^swap .* 9:2$/.test(l))).toBe(true);
      expect(layerOf(layers, '3:6;9:4').text).toBe('Basic');
    });

    it.each<{ what: string; frameId: string; modes: Record<string, string>; mode: string }>([
      { what: "the page's mode", frameId: '1:2', modes: {}, mode: LIGHT },
      { what: 'the mode SET_VARIABLE_MODE chose', frameId: '1:2', modes: { [COLL]: DARK }, mode: DARK },
      { what: "the frame's own mode, over the chosen one", frameId: '3:5', modes: { [COLL]: LIGHT }, mode: DARK },
    ])('sets $what on the copy', async ({ frameId, modes, mode }) => {
      const fake = await setup();
      const { image } = await fake.renderer.render(fake.doc, state(fake.doc, frameId, { modes }));
      expect(drawn(image).children?.[0]?.explicitVariableModes).toEqual({ [COLL]: mode });
      // The same helper the expressions use decides it, so a render and an expression can't disagree.
      const collection = fake.doc.variableCollections[COLL] as VariableCollection;
      expect(activeMode({ doc: fake.doc, state: state(fake.doc, frameId, { modes }), frameId }, collection)).toBe(mode);
    });

    it('writes assigned variable values into the copies, unbinding them: text, visibility and fills', async () => {
      const fake = await setup();
      const variables = { [COLL]: { [LIGHT]: { 'VariableID:10:4': 'Hi, Mara', 'VariableID:10:1': true, 'VariableID:10:3': { r: 1, g: 0, b: 0, a: 0.5 } } } };

      const dashboard = drawn((await fake.renderer.render(fake.doc, state(fake.doc, '1:2', { variables }))).image);
      expect(find(dashboard, 'Greeting').characters).toBe('Hi, Mara');
      expect(fake.world.log).toContain(`loadFont ${JSON.stringify({ family: 'Inter', style: 'Regular' })}`);

      const connected = drawn((await fake.renderer.render(fake.doc, state(fake.doc, '2:50', { variables }))).image);
      expect(find(connected, 'Linked badge').visible).toBe(true);

      const connect = drawn((await fake.renderer.render(fake.doc, state(fake.doc, '2:20', { variables }))).image);
      expect(find(connect, 'Continue').fills).toEqual([{ type: 'SOLID', color: { r: 1, g: 0, b: 0 }, opacity: 0.5, visible: true }]);
    });

    it.each([
      { what: 'in the mode the frame is read in', modes: { [COLL]: DARK }, assignedIn: DARK, characters: 'Hi, Mara' },
      { what: 'not when assigned in another mode', modes: { [COLL]: DARK }, assignedIn: LIGHT, characters: 'Welcome back, Mara' },
    ])('writes an assigned value $what', async ({ modes, assignedIn, characters }) => {
      const fake = await setup();
      const variables = { [COLL]: { [assignedIn]: { 'VariableID:10:4': 'Hi, Mara' } } };
      const { image } = await fake.renderer.render(fake.doc, state(fake.doc, '1:2', { modes, variables }));
      expect(find(drawn(image), 'Greeting').characters).toBe(characters);
    });

    it.each([true, false])('writes visibility %s', async (shown) => {
      const fake = await setup((f) => (node(f, '1:5').boundVariables = { visible: { type: 'VARIABLE_ALIAS', id: 'VariableID:10:1' } }));
      const variables = { [COLL]: { [LIGHT]: { 'VariableID:10:1': shown } } };
      const { image } = await fake.renderer.render(fake.doc, state(fake.doc, '1:2', { variables }));
      expect(find(drawn(image), 'Greeting').visible).toBe(shown);
    });

    it.each([
      { field: 'minWidth', value: 120 },
      { field: 'strokeTopWeight', value: 2 },
      { field: 'gridRowGap', value: 8 },
    ])('writes a number into the bound $field', async ({ field, value }) => {
      const fake = await setup((f) => (node(f, '2:52').boundVariables = { [field]: { type: 'VARIABLE_ALIAS', id: 'VariableID:10:2' } }));
      const variables = { [COLL]: { [LIGHT]: { 'VariableID:10:2': value } } };
      const badge = find(drawn((await fake.renderer.render(fake.doc, state(fake.doc, '2:50', { variables }))).image), 'Linked badge');
      expect((badge as unknown as Record<string, unknown>)[field]).toBe(value);
    });

    it("writes a value bound to a component property through the instance's properties", async () => {
      const alias = { type: 'VARIABLE_ALIAS', id: 'VariableID:10:4' };
      const fake = await setup((f) => {
        node(f, '2:11').componentProperties = { 'Label#1:2': { type: 'TEXT', value: 'Connect a bank', boundVariables: { value: alias } } };
        node(f, '2:11').boundVariables = { componentProperties: { 'Label#1:2': alias } };
      });
      const variables = { [COLL]: { [LIGHT]: { 'VariableID:10:4': 'Link your bank' } } };
      const { image } = await fake.renderer.render(fake.doc, state(fake.doc, '2:10', { variables }));
      const props = (find(drawn(image), 'Connect a bank') as unknown as { componentProperties: Record<string, { value: string; boundVariables?: unknown }> }).componentProperties;
      expect(props['Label#1:2']).toEqual({ type: 'TEXT', value: 'Link your bank' });
    });

    it.each([
      { what: 'a typography field', bound: { fontSize: [{ type: 'VARIABLE_ALIAS', id: 'VariableID:10:2' }] }, field: 'fontSize' },
      { what: 'an effect', bound: { effects: [{ type: 'VARIABLE_ALIAS', id: 'VariableID:10:2' }] }, field: 'effects' },
      { what: 'a layout grid', bound: { layoutGrids: [{ type: 'VARIABLE_ALIAS', id: 'VariableID:10:2' }] }, field: 'layoutGrids' },
      { what: 'a text range fill', bound: { textRangeFills: [{ type: 'VARIABLE_ALIAS', id: 'VariableID:10:2' }] }, field: 'textRangeFills' },
      { what: 'a value of the wrong type', bound: { visible: { type: 'VARIABLE_ALIAS', id: 'VariableID:10:2' } }, field: 'visible' },
    ])("refuses to render $what it can't show the assigned value of, naming the field and the layer", async ({ bound, field }) => {
      const fake = await setup((f) => (node(f, '1:5').boundVariables = bound));
      const variables = { [COLL]: { [LIGHT]: { 'VariableID:10:2': 3 } } };
      await expect(fake.renderer.render(fake.doc, state(fake.doc, '1:2', { variables }))).rejects.toThrow(new RegExp(`${field}.*1:5`));
      // Bound but not assigned, it is drawn as designed.
      await expect(fake.renderer.render(fake.doc, state(fake.doc, '1:2'))).resolves.toBeDefined();
    });

    it('writes a number into a bound numeric property', async () => {
      const fake = await setup((f) => (node(f, '2:52').boundVariables = { opacity: { type: 'VARIABLE_ALIAS', id: 'VariableID:10:2' } }));
      const variables = { [COLL]: { [LIGHT]: { 'VariableID:10:2': 0.5 } } };
      const badge = find(drawn((await fake.renderer.render(fake.doc, state(fake.doc, '2:50', { variables }))).image), 'Linked badge');
      expect(badge.opacity).toBe(0.5);
    });

    it('leaves values the state did not assign as designed', async () => {
      const fake = await setup();
      const { image } = await fake.renderer.render(fake.doc, state(fake.doc, '2:20'));
      expect(find(drawn(image), 'Continue').fills?.[0]?.boundVariables).toEqual({ color: { type: 'VARIABLE_ALIAS', id: 'VariableID:10:3' } });
    });

    it('leaves text whose font is missing as designed, and says so', async () => {
      const fake = await setup((f) => (node(f, '1:5').hasMissingFont = true));
      const variables = { [COLL]: { [LIGHT]: { 'VariableID:10:4': 'Hi, Mara' } } };
      const { image, notes } = await fake.renderer.render(fake.doc, state(fake.doc, '1:2', { variables }));
      expect(find(drawn(image), 'Greeting').characters).toBe('Welcome back, Mara');
      expect(notes).toEqual([{ missing_font: ['Inter Regular'] }]);
    });
  });

  describe('measured layers', () => {
    it("keep a nested component's type, though its copy is an instance of it", async () => {
      const fake = await setup((f) => {
        const promo = new FakeNode('1:20', 'Promo', 'COMPONENT');
        promo.world = f.world;
        promo.width = 200;
        promo.height = 40;
        const label = new FakeNode('1:21', 'Label', 'TEXT');
        label.world = f.world;
        label.characters = 'New';
        promo.add(label);
        f.nodes.set('1:20', promo);
        f.nodes.set('1:21', label);
        node(f, '1:2').add(promo);
      });
      const { layers } = await fake.renderer.render(fake.doc, state(fake.doc, '1:2'));
      expect(layerOf(layers, '1:20').type).toBe('COMPONENT');
      expect(layerOf(layers, '1:21').parentKey).toBe('1:20');
    });

    it('follow itemReverseZIndex: the first child is drawn on top', async () => {
      const fake = await setup((f) => (node(f, '2:10').itemReverseZIndex = true));
      const { layers } = await fake.renderer.render(fake.doc, state(fake.doc, '2:10'));
      const order = layers.filter((l) => l.parentKey === '2:10').map((l) => l.key);
      expect(order).toEqual(['2:13', '2:12', '2:11']);
    });

    it('count a stroke of mixed weights as drawn', async () => {
      const fake = await setup((f) => {
        node(f, '1:8').strokes = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 1, visible: true }];
        node(f, '1:8').strokeWeight = Symbol('mixed');
      });
      const { layers } = await fake.renderer.render(fake.doc, state(fake.doc, '1:2'));
      expect(layerOf(layers, '1:8').paints).toBe(true);
    });

    it('come from the copies in paint order, keyed by the original ids', async () => {
      const fake = await setup();
      const { layers } = await fake.renderer.render(fake.doc, state(fake.doc, '2:20'));
      const keys = layers.map((l) => l.key);
      expect(keys.slice(0, 3)).toEqual(['2:20', '2:25', '2:60']);
      expect(keys.indexOf('2:28')).toBeGreaterThan(keys.indexOf('2:22'));
      expect(new Set(keys).size).toBe(keys.length);
      expect(layerOf(layers, 'I2:21;6:3')).toEqual({
        key: 'I2:21;6:3',
        type: 'TEXT',
        name: 'Label',
        text: 'Sign in with your bank',
        box: { x: 56, y: 612, width: 288, height: 24 },
        unclippedBox: { x: 56, y: 612, width: 288, height: 24 },
        visible: true,
        paints: true,
        hasReactions: false,
        roleHint: 'text',
        parentKey: '2:21',
        scroll: null,
        fixed: false,
      });
    });

    it('measure hidden layers, transparent hotspots and wiring', async () => {
      const fake = await setup((f) => (node(f, '1:3').fills = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 1, visible: false }]));
      const { layers } = await fake.renderer.render(fake.doc, state(fake.doc, '1:2'));
      expect(layerOf(layers, '1:8')).toMatchObject({ paints: false, hasReactions: true, visible: true });
      // A fill that is switched off draws nothing either.
      expect(layerOf(layers, '1:3').paints).toBe(false);
      const connect = (await fake.renderer.render(fake.doc, state(fake.doc, '2:20'))).layers;
      expect(layerOf(connect, 'I2:21;6:4')).toMatchObject({ visible: false, hasReactions: true });
      expect(layerOf(connect, '2:23')).toMatchObject({ paints: false });
    });

    it('clip boxes to clipsContent ancestors, keeping the unclipped box', async () => {
      const fake = await setup();
      const { layers } = await fake.renderer.render(fake.doc, state(fake.doc, '2:20'));
      // The bank list (y 160 to 560) shows rows 0 to 4; row 5 is drawn at y 560 and clipped away.
      expect(layerOf(layers, '2:64').box).toEqual({ x: 40, y: 480, width: 600, height: 80 });
      expect(layerOf(layers, '2:65')).toMatchObject({ box: { x: 40, y: 560, width: 0, height: 0 }, unclippedBox: { x: 40, y: 560, width: 600, height: 80 } });
    });

    it('describe scroll areas by their content at offset zero, and fixed children', async () => {
      const fake = await setup();
      const { layers } = await fake.renderer.render(fake.doc, state(fake.doc, '2:20'));
      expect(layerOf(layers, '2:25').scroll).toEqual({ direction: 'VERTICAL', maxX: 0, maxY: 400 });
      // A frame scrolls as a page, from its own size: its root layer carries no scroll area.
      expect(layerOf(layers, '2:20').scroll).toBeNull();
      expect(layerOf(layers, '2:28').fixed).toBe(true);
      expect(layerOf(layers, '2:22').fixed).toBe(false);
    });

    it.each([
      { height: 80.4, maxY: 400 },
      { height: 80.6, maxY: 401 },
    ])('round a scroll range measured in fractions to whole pixels, as the engine scrolls it ($height px row: $maxY)', async ({ height, maxY }) => {
      // The last bank row reaches past the list by a fraction of a pixel more.
      const fake = await setup((f) => (node(f, '2:69').height = height));
      const { layers } = await fake.renderer.render(fake.doc, state(fake.doc, '2:20'));
      expect(layerOf(layers, '2:25').scroll).toEqual({ direction: 'VERTICAL', maxX: 0, maxY });
    });

    it('leave hidden content out of a scroll range', async () => {
      const fake = await setup((f) => (node(f, '2:69').visible = false));
      const { layers } = await fake.renderer.render(fake.doc, state(fake.doc, '2:20'));
      expect(layerOf(layers, '2:25').scroll).toEqual({ direction: 'VERTICAL', maxX: 0, maxY: 320 });
    });

    it.each([
      { key: '2:12', roleHint: 'icon' },
      { key: '2:35', roleHint: 'input' },
      { key: '2:34', roleHint: 'text' },
      { key: '2:31', roleHint: null },
    ])('hint $key as $roleHint', async ({ key, roleHint }) => {
      const fake = await setup();
      const frameId = key === '2:12' ? '2:10' : '2:30';
      const { layers } = await fake.renderer.render(fake.doc, state(fake.doc, frameId));
      expect(layerOf(layers, key).roleHint).toBe(roleHint);
    });

    it('hint an image fill as an image, and underlined text as a link', async () => {
      const fake = await setup((f) => {
        node(f, '2:35').fills = [{ type: 'IMAGE', imageHash: 'abc', scaleMode: 'FILL', visible: true }];
        node(f, '2:34').textDecoration = 'UNDERLINE';
      });
      const { layers } = await fake.renderer.render(fake.doc, state(fake.doc, '2:30'));
      expect(layerOf(layers, '2:35')).toMatchObject({ roleHint: 'image', paints: true });
      expect(layerOf(layers, '2:34').roleHint).toBe('link');
    });
  });

  describe('scroll', () => {
    it('scrolls an area inside an instance by detaching that instance on the copy, keeping its layers\' keys and types', async () => {
      const fake = await setup();
      const s = state(fake.doc, '3:5', { scroll: { '3:5': { x: 0, y: 0, areas: { 'I3:8;6:21': { x: 150, y: 0 } } } } });
      const { layers } = await fake.renderer.render(fake.doc, s);
      expect(fake.world.log?.some((l) => l.startsWith('detach '))).toBe(true);
      expect(layerOf(layers, '3:8').type).toBe('INSTANCE');
      expect(layerOf(layers, 'I3:8;6:21')).toMatchObject({ type: 'FRAME', scroll: { direction: 'HORIZONTAL', maxX: 196, maxY: 0 } });
      // The first chip moved 150 left, from x = 40.
      expect(layerOf(layers, 'I3:8;6:22').unclippedBox.x).toBe(-110);
      expect(layerOf(layers, 'I3:8;6:33').parentKey).toBe('I3:8;6:22');
    });

    it('pins the fixed children of a top level instance screen by detaching it on the copy', async () => {
      const fake = await setup();
      const s = state(fake.doc, '4:5', { scroll: { '4:5': { x: 0, y: 300, areas: {} } } });
      const { layers } = await fake.renderer.render(fake.doc, s);
      expect(layerOf(layers, '4:5')).toMatchObject({ type: 'INSTANCE', box: { x: 0, y: -300, width: 1280, height: 1400 } });
      expect(layerOf(layers, 'I4:5;6:42')).toMatchObject({ fixed: true, box: { x: 0, y: 0, width: 1280, height: 80 } });
      expect(layerOf(layers, 'I4:5;6:41').box.y).toBe(-180);
    });

    it("keeps a scroll area's own fixed children in place while its content moves", async () => {
      const fake = await setup((f) => (node(f, '2:25').numberOfFixedChildren = 1));
      const s = state(fake.doc, '2:20', { scroll: { '2:20': { x: 0, y: 0, areas: { '2:25': { x: 0, y: 160 } } } } });
      const { layers } = await fake.renderer.render(fake.doc, s);
      expect(layerOf(layers, '2:69')).toMatchObject({ fixed: true, unclippedBox: { x: 40, y: 880, width: 600, height: 80 } });
      expect(layerOf(layers, '2:62').unclippedBox.y).toBe(160);
    });

    it('moves the page and each area, pinning fixed children', async () => {
      const fake = await setup();
      const s = state(fake.doc, '2:20', { scroll: { '2:20': { x: 0, y: 300, areas: { '2:25': { x: 0, y: 160 } } } } });
      const { layers } = await fake.renderer.render(fake.doc, s);
      expect(layerOf(layers, '2:20').box.y).toBe(-300);
      // The header is fixed: it stays at the top of the viewport.
      expect(layerOf(layers, '2:28').box).toEqual({ x: 0, y: 0, width: 1280, height: 96 });
      // The list moved up with the page; its rows moved up by 160 more, so row 2 is at its top.
      expect(layerOf(layers, '2:25').box.y).toBe(-140);
      expect(layerOf(layers, '2:62').unclippedBox.y).toBe(-140);
      // The area's range doesn't depend on where it was scrolled to.
      expect(layerOf(layers, '2:25').scroll).toEqual({ direction: 'VERTICAL', maxX: 0, maxY: 400 });
    });
  });

  describe('with the engine and the element list', () => {
    it('measures what they act on: a click on "Connect a bank" goes to Connect bank', async () => {
      const fake = await setup();
      const s0 = state(fake.doc, '2:10');
      const { layers } = await fake.renderer.render(fake.doc, s0);
      const { elements, targets } = listElements(layers, s0);
      const connect = elements.find((e) => e.label === 'Connect a bank');
      expect(connect?.role).toBe('button');
      const { state: s1, outcome } = apply(fake.doc, s0, { type: 'click', element: connect?.id ?? 'missing' }, layers, targets);
      expect(outcome).toBe('navigated');
      expect(s1.frameId).toBe('2:20');
    });

    it('turns an interactive component on and off again through the swapped variant\'s layers', async () => {
      const fake = await setup();
      const s0 = state(fake.doc, '2:30');
      const toggle = async (s: TraceState) => {
        const { layers } = await fake.renderer.render(fake.doc, s);
        const { elements, targets } = listElements(layers, s);
        const element = elements.find((e) => e.label === 'Remember this device');
        return apply(fake.doc, s, { type: 'click', element: element?.id ?? 'missing' }, layers, targets);
      };
      const on = await toggle(s0);
      expect(on.outcome).toBe('changed_state');
      expect(on.state.variants).toEqual({ '2:30': { '2:33': '8:4' } });
      const off = await toggle(on.state);
      expect(off.state.variants).toEqual({ '2:30': { '2:33': '8:2' } });
    });
  });
});
