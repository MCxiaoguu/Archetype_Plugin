import { describe, expect, it } from 'vitest';
import fixtureJson from '../harness/fixtures/farside-proto.json';
import type { ProtoAction, ProtoDoc } from '../src/lib/proto/model';
import { topLevelFrames } from '../src/main/document';
import { readProto } from '../src/main/protoReader';
import { SCRATCH_KEY, SCRATCH_VALUE } from '../src/main/scratch';
import { FakeNode, fakeFromFixture, type ProtoFixture } from './fake-figma';

const COLL = 'VariableCollectionId:10:0';
const fixture = () => structuredClone(fixtureJson) as unknown as ProtoFixture;

async function read(options = { importLibraryVariants: true }, edit: (f: ReturnType<typeof fakeFromFixture>) => void = () => {}) {
  const fake = fakeFromFixture(fixture());
  edit(fake);
  const doc = await readProto(fake.api, fake.api.currentPage, options);
  return { ...fake, doc };
}

const node = (fake: ReturnType<typeof fakeFromFixture>, id: string) => fake.nodes.get(id) as FakeNode;

/** A NODE action with the flags the reader fills in when Figma leaves them out. */
const go = (destinationId: string | null, navigation = 'NAVIGATE', flags: Partial<Extract<ProtoAction, { type: 'NODE' }>> = {}): ProtoAction => ({
  type: 'NODE',
  navigation: navigation as Extract<ProtoAction, { type: 'NODE' }>['navigation'],
  destinationId,
  resetScrollPosition: false,
  preserveScrollPosition: true,
  resetInteractiveComponents: false,
  overlayRelativePosition: null,
  ...flags,
});

describe('readProto', () => {
  describe('frames', () => {
    it("reads the page's top level frames, and a frame on another page that a reaction reaches", async () => {
      const fake = await read();
      // 7:5 is reached only from a variant of an interactive component.
      expect(fake.doc.frames.map((f) => f.id)).toEqual(['1:2', '2:10', '2:20', '2:30', '2:40', '2:50', '3:1', '3:3', '3:5', '4:1', '7:1', '7:5']);
      expect(fake.doc.frames.find((f) => f.id === '7:1')).toMatchObject({ name: 'Release notes', pageId: '0:2' });
      expect(fake.api.getNodeByIdAsync).toHaveBeenCalledWith('7:1');
      // Another page's layers are loaded before they are read; its reactions count too.
      expect((fake.pages[1] as FakeNode).loadAsync).toHaveBeenCalled();
      expect(fake.doc.reactions['7:2']).toEqual([{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'BACK' }] }]);
    });

    it('reads size, scrolling and fixed children', async () => {
      const { doc } = await read();
      expect(doc.frames.find((f) => f.id === '2:20')).toMatchObject({
        pageId: '0:1',
        width: 1280,
        height: 1600,
        overflowDirection: 'VERTICAL',
        numberOfFixedChildren: 1,
      });
    });

    it("reads each frame's overlay settings", async () => {
      const { doc } = await read();
      const overlay = (id: string) => doc.frames.find((f) => f.id === id)?.overlay;
      expect(overlay('3:1')).toEqual({ position: 'CENTER', background: { type: 'SOLID_COLOR', color: { r: 0, g: 0, b: 0, a: 0.4 } }, closeOnOutsideClick: true });
      expect(overlay('3:3')).toEqual({ position: 'MANUAL', background: { type: 'NONE' }, closeOnOutsideClick: false });
    });

    it('skips the scratch container, in readProto and in the preflight reader', async () => {
      const scratch = new FakeNode('99:1', 'Archetype scratch', 'FRAME');
      scratch.setPluginData(SCRATCH_KEY, SCRATCH_VALUE);
      const copy = new FakeNode('99:2', 'Billing', 'TEXT');
      copy.reactions = [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'BACK' }] }];
      scratch.add(copy);
      const fake = await read(undefined, (f) => (f.pages[0] as FakeNode).add(scratch));
      expect(fake.doc.frames.map((f) => f.id)).not.toContain('99:1');
      expect(fake.doc.reactions['99:2']).toBeUndefined();
      expect(topLevelFrames(fake.api.currentPage).map((f) => f.id)).not.toContain('99:1');
    });
  });

  describe('reactions', () => {
    it('reads every reaction of every layer in the flow', async () => {
      const { doc } = await read();
      expect(Object.keys(doc.reactions).sort()).toEqual(
        ['1:7', '1:8', '1:10', '1:11', '2:11', '2:12', '2:13', '2:21', 'I2:21;6:4', '2:22', '2:23', '2:30', '2:31', '2:32', '2:33', '2:34', '2:41', '2:42', '2:51', '3:1', '3:2', '3:6', '4:2', '7:2'].sort(),
      );
    });

    it('reads trigger types, delays and key codes', async () => {
      const { doc } = await read();
      expect(doc.reactions['2:12']?.map((r) => r.trigger)).toEqual([{ type: 'ON_CLICK' }, { type: 'MOUSE_ENTER', delayMs: 500 }]);
      expect(doc.reactions['2:30']?.[0]?.trigger).toEqual({ type: 'ON_KEY_DOWN', device: 'KEYBOARD', keyCodes: [13] });
      expect(doc.reactions['3:1']?.[0]?.trigger).toEqual({ type: 'AFTER_TIMEOUT', delayMs: 4000 });
    });

    it('reads hidden layers inside instances, so skipInvisibleInstanceChildren is off during the read and back on after', async () => {
      const fake = await read();
      expect(fake.doc.reactions['I2:21;6:4']).toEqual([{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'URL', url: 'https://status.example.com' }] }]);
      expect(fake.api.skipInvisibleInstanceChildren).toBe(true);
    });

    it('puts skipInvisibleInstanceChildren back when the read throws', async () => {
      const fake = fakeFromFixture(fixture());
      fake.api.variables.getLocalVariableCollectionsAsync.mockRejectedValueOnce(new Error('variables unavailable'));
      await expect(readProto(fake.api, fake.api.currentPage, { importLibraryVariants: true })).rejects.toThrow('variables unavailable');
      expect(fake.api.skipInvisibleInstanceChildren).toBe(true);
    });

    it('reads NODE actions with their flags, filling in what Figma leaves out', async () => {
      const { doc } = await read();
      const first = (id: string) => doc.reactions[id]?.[0]?.actions;
      expect(first('1:7')).toEqual([go('2:10')]);
      expect(first('2:22')).toEqual([go('2:30', 'NAVIGATE', { resetScrollPosition: true, preserveScrollPosition: false })]);
      // Only the deprecated flag: the scroll resets, and the newer field says so too.
      expect(first('2:51')).toEqual([go('1:2', 'NAVIGATE', { resetScrollPosition: true, preserveScrollPosition: false, resetInteractiveComponents: true })]);
      expect(doc.reactions['2:12']?.[1]?.actions).toEqual([go('3:3', 'OVERLAY', { overlayRelativePosition: { x: 0, y: 36 } })]);
      expect(first('2:23')).toEqual([go(null)]);
      // Old files carry a single deprecated `action`.
      expect(first('2:21')).toEqual([go('3:1', 'OVERLAY')]);
      expect(first('3:6')).toEqual([go('9:3', 'CHANGE_TO')]);
    });

    it('reads variable actions, with conditions and values as expression trees', async () => {
      const { doc } = await read();
      expect(doc.reactions['2:11']?.[0]?.actions).toEqual([
        {
          type: 'CONDITIONAL',
          blocks: [
            {
              condition: { kind: 'op', operator: 'EQUALS', operands: [{ kind: 'alias', variableId: 'VariableID:10:1' }, { kind: 'literal', value: true }] },
              actions: [go('2:50')],
            },
            { condition: null, actions: [go('2:20')] },
          ],
        },
      ]);
      expect(doc.reactions['2:34']?.[0]?.actions[0]).toEqual({
        type: 'SET_VARIABLE',
        variableId: 'VariableID:10:2',
        value: { kind: 'op', operator: 'ADDITION', operands: [{ kind: 'alias', variableId: 'VariableID:10:2' }, { kind: 'literal', value: 1 }] },
      });
      expect(doc.reactions['2:31']?.[0]?.actions).toEqual([
        { type: 'SET_VARIABLE', variableId: 'VariableID:10:1', value: { kind: 'literal', value: true } },
        go('2:50'),
      ]);
      expect(doc.reactions['1:11']?.[0]?.actions).toEqual([{ type: 'SET_VARIABLE_MODE', collectionId: COLL, modeId: '10:1' }]);
      expect(doc.reactions['2:42']?.[0]?.actions).toEqual([{ type: 'URL', url: 'https://www.nacha.org/content/what-is-ach' }]);
    });

    it('keeps what it does not model as UNKNOWN or unsupported, and leaves out a reaction with no trigger', async () => {
      const { doc } = await read(undefined, (f) => {
        node(f, '1:8').reactions = [
          { trigger: { type: 'ON_KEY_UP', device: 'KEYBOARD', keyCodes: [27] }, actions: [{ type: 'BACK' }] },
          {
            trigger: { type: 'ON_CLICK' },
            actions: [
              { type: 'OPEN_APP' },
              { type: 'UPDATE_MEDIA_RUNTIME', destinationId: null, mediaAction: 'PLAY' },
              { type: 'SET_VARIABLE', variableId: 'VariableID:10:2', variableValue: { type: 'EXPRESSION', value: { expressionFunction: 'POWER', expressionArguments: [] } } },
              { type: 'SET_VARIABLE', variableId: 'VariableID:10:2' },
            ],
          },
          { trigger: null, actions: [{ type: 'BACK' }] },
        ];
      });
      expect(doc.reactions['1:8']).toEqual([
        { trigger: { type: 'UNKNOWN', rawType: 'ON_KEY_UP' }, actions: [{ type: 'BACK' }] },
        {
          trigger: { type: 'ON_CLICK' },
          actions: [
            { type: 'UNKNOWN', rawType: 'OPEN_APP' },
            { type: 'UPDATE_MEDIA_RUNTIME' },
            { type: 'SET_VARIABLE', variableId: 'VariableID:10:2', value: { kind: 'unsupported', detail: 'the expression function POWER' } },
            { type: 'SET_VARIABLE', variableId: 'VariableID:10:2', value: null },
          ],
        },
      ]);
    });
  });

  describe('interactive components', () => {
    it('reads the variants a CHANGE_TO can show, with their reactions keyed by path inside the variant', async () => {
      const { doc } = await read();
      expect(doc.variantSets['2:33']).toEqual({
        frameId: '2:30',
        variants: [
          { id: '8:2', name: 'State=Off', componentId: '8:2', unavailable: false, reactions: { '': [{ trigger: { type: 'ON_CLICK' }, actions: [go('8:4', 'CHANGE_TO')] }] } },
          {
            id: '8:4',
            name: 'State=On',
            componentId: '8:4',
            unavailable: false,
            reactions: {
              '': [{ trigger: { type: 'ON_CLICK' }, actions: [go('8:2', 'CHANGE_TO')] }],
              '8:5': [{ trigger: { type: 'ON_HOVER' }, actions: [go('3:3', 'OVERLAY', { overlayRelativePosition: { x: 0, y: 28 } })] }],
              // A nested instance, and a layer inside it (Figma's id I8:6;6:12).
              '8:6': [{ trigger: { type: 'ON_CLICK' }, actions: [go('6:13', 'CHANGE_TO')] }],
              '8:6;6:12': [{ trigger: { type: 'ON_HOVER' }, actions: [{ type: 'URL', url: 'https://help.example.com/saved' }] }],
            },
          },
        ],
      });
    });

    it('reads an interactive component inside a variant under its path key', async () => {
      const { doc } = await read();
      expect(doc.variantSets['2:33;8:6']).toEqual({
        frameId: '2:30',
        variants: [
          { id: '6:11', name: 'Tone=Muted', componentId: '6:11', unavailable: false, reactions: { '': [{ trigger: { type: 'ON_CLICK' }, actions: [go('6:13', 'CHANGE_TO')] }] } },
          {
            id: '6:13',
            name: 'Tone=Bright',
            componentId: '6:13',
            unavailable: false,
            reactions: { '': [{ trigger: { type: 'ON_CLICK' }, actions: [go('6:11', 'CHANGE_TO')] }], '6:14': [{ trigger: { type: 'ON_CLICK' }, actions: [go('7:5')] }] },
          },
        ],
      });
      expect(Object.keys(doc.variantSets).sort()).toEqual(['2:33', '2:33;8:6', '3:6']);
    });

    it('imports library variants, and marks one whose import fails unavailable without throwing', async () => {
      const fake = await read();
      expect(fake.api.importComponentByKeyAsync).toHaveBeenCalledWith('lib-plan-basic');
      expect(fake.doc.variantSets['3:6']).toEqual({
        frameId: '3:5',
        variants: [
          { id: '9:2', name: 'Plan=Basic', componentId: 'L:2', unavailable: false, reactions: { '': [{ trigger: { type: 'ON_CLICK' }, actions: [go('9:3', 'CHANGE_TO')] }] } },
          { id: '9:3', name: 'Plan=Pro', componentId: null, unavailable: true, reactions: {} },
        ],
      });
      expect(fake.doc.libraryVariants).toEqual([
        { variantId: '9:2', key: 'lib-plan-basic', name: 'Plan=Basic', status: 'imported' },
        { variantId: '9:3', key: 'lib-plan-pro', name: 'Plan=Pro', status: 'failed' },
      ]);
    });

    it('imports nothing unless it may, and lists what the flow would import', async () => {
      const fake = await read({ importLibraryVariants: false });
      expect(fake.api.importComponentByKeyAsync).not.toHaveBeenCalled();
      expect(fake.doc.variantSets['3:6']?.variants.map((v) => [v.id, v.unavailable])).toEqual([
        ['9:2', true],
        ['9:3', true],
      ]);
      expect(fake.doc.libraryVariants.map((v) => v.status)).toEqual(['needs_import', 'needs_import']);
    });
  });

  describe('variables', () => {
    it('reads the local variable collections, their modes and values, aliases included', async () => {
      const { doc } = await read();
      const billing = doc.variableCollections[COLL];
      expect(billing).toMatchObject({ id: COLL, name: 'Billing', defaultModeId: '10:0', modes: [{ modeId: '10:0', name: 'Light' }, { modeId: '10:1', name: 'Dark' }] });
      expect(billing?.variables['VariableID:10:1']).toEqual({ id: 'VariableID:10:1', name: 'bankLinked', resolvedType: 'BOOLEAN', valuesByMode: { '10:0': false, '10:1': false } });
      expect(billing?.variables['VariableID:10:3']?.valuesByMode['10:0']).toEqual({ r: 0.15, g: 0.35, b: 0.9, a: 1 });
      expect(billing?.variables['VariableID:10:5']?.valuesByMode).toEqual({ '10:0': { alias: 'VariableID:10:3' }, '10:1': { alias: 'VariableID:10:3' } });
    });

    it("reads the page's and the frames' explicit modes", async () => {
      const { doc } = await read();
      expect(doc.explicitVariableModes).toEqual({ [COLL]: '10:0' });
      expect(doc.frames.find((f) => f.id === '3:5')?.explicitVariableModes).toEqual({ [COLL]: '10:1' });
      expect(doc.frames.find((f) => f.id === '1:2')?.explicitVariableModes).toEqual({});
    });

    it('leaves out variables a prototype expression here cannot use (easing, timing)', async () => {
      const f = fixture();
      f.variableCollections[0]?.variables.push({ id: 'VariableID:10:9', name: 'ease', resolvedType: 'EASING', valuesByMode: { '10:0': { type: 'EASE_IN' } } });
      const fake = fakeFromFixture(f);
      const doc = await readProto(fake.api, fake.api.currentPage, { importLibraryVariants: true });
      expect(doc.variableCollections[COLL]?.variables['VariableID:10:9']).toBeUndefined();
    });
  });

  describe('docHash', () => {
    const hash = async (edit?: (f: ReturnType<typeof fakeFromFixture>) => void) => (await read(undefined, edit)).doc.docHash;

    it('is the same for the same file', async () => {
      const [a, b] = await Promise.all([hash(), hash()]);
      expect(a).toMatch(/^[0-9a-f]{14}$/);
      expect(a).toBe(b);
    });

    it('changes when a reaction changes', async () => {
      const changed = await hash((f) => {
        node(f, '1:7').reactions = [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', destinationId: '2:20', navigation: 'NAVIGATE', transition: null }] }];
      });
      expect(changed).not.toBe(await hash());
    });

    it('covers everything the engine reads, so the doc it describes is the doc it hashes', async () => {
      const { doc } = await read();
      const rest: Partial<ProtoDoc> = { ...doc };
      delete rest.docHash;
      expect(Object.keys(rest).sort()).toEqual(['explicitVariableModes', 'frames', 'libraryVariants', 'pageId', 'pageName', 'reactions', 'variableCollections', 'variantSets']);
    });
  });
});
