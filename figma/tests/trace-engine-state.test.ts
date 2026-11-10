import { describe, expect, it } from 'vitest';
import { settle, start } from '../src/lib/proto/engine';
import { evaluate, ExprError } from '../src/lib/proto/expr';
import { KEY_NAMES, keyCodes, MODIFIER_NAMES } from '../src/lib/proto/keys';
import type {
  KeyDevice,
  ProtoAction,
  ProtoDoc,
  ProtoReaction,
  ProtoVariant,
  RGBA,
  TraceAction,
  TraceState,
  VariableCollection,
  VariableDef,
  VariableExpr,
  VariableExprOperator,
  VariableLiteral,
  VariableType,
  VariableValue,
} from '../src/lib/proto/model';
import {
  A,
  act,
  B,
  C,
  click,
  frame,
  hover,
  layer,
  navigate,
  node,
  on,
  openOverlay,
  overlayFrame,
  protoDoc,
  screenA,
} from './trace-fixtures';

// --- Builders ----------------------------------------------------------------

const lit = (value: VariableLiteral): VariableExpr => ({ kind: 'literal', value });
const ref = (variableId: string): VariableExpr => ({ kind: 'alias', variableId });
const op = (operator: VariableExprOperator, ...operands: VariableExpr[]): VariableExpr => ({ kind: 'op', operator, operands });

const setVariable = (variableId: string, value: VariableExpr): ProtoAction => ({ type: 'SET_VARIABLE', variableId, value });
const setMode = (collectionId: string, modeId: string): ProtoAction => ({ type: 'SET_VARIABLE_MODE', collectionId, modeId });
const when = (...blocks: Array<[VariableExpr | null, ...ProtoAction[]]>): ProtoAction => ({
  type: 'CONDITIONAL',
  blocks: blocks.map(([condition, ...actions]) => ({ condition, actions })),
});
const changeTo = (variantId: string): ProtoAction => node('CHANGE_TO', variantId);
const keyDown = (keyCodes: number[], action: ProtoAction, device: KeyDevice = 'KEYBOARD'): ProtoReaction => ({
  trigger: { type: 'ON_KEY_DOWN', device, keyCodes },
  actions: [action],
});
const afterDelay = (delayMs: number, ...actions: ProtoAction[]): ProtoReaction => ({ trigger: { type: 'AFTER_TIMEOUT', delayMs }, actions });

const red: RGBA = { r: 1, g: 0, b: 0, a: 1 };
const blue: RGBA = { r: 0, g: 0, b: 1, a: 1 };

function variable(id: string, resolvedType: VariableType, valuesByMode: Record<string, VariableValue>): VariableDef {
  return { id, name: id, resolvedType, valuesByMode };
}

function collection(id: string, modeIds: string[], variables: VariableDef[]): VariableCollection {
  return {
    id,
    name: id,
    modes: modeIds.map((modeId) => ({ modeId, name: modeId })),
    defaultModeId: modeIds[0] as string,
    variables: Object.fromEntries(variables.map((v) => [v.id, v])),
  };
}

/** Collection `ui` has modes `light` (the default) and `dark`; `shop` has one mode. */
const collections = {
  ui: collection('ui', ['light', 'dark'], [
    variable('count', 'FLOAT', { light: 2, dark: 5 }),
    variable('name', 'STRING', { light: 'Mara', dark: 'Mara' }),
    variable('on', 'BOOLEAN', { light: true, dark: false }),
    variable('tint', 'COLOR', { light: red, dark: blue }),
    variable('total', 'FLOAT', { light: { alias: 'count' }, dark: 7 }),
  ]),
  shop: collection('shop', ['only'], [variable('price', 'FLOAT', { only: 10 })]),
};

function varDoc(reactions: Record<string, ProtoReaction[]> = {}, extra: Partial<ProtoDoc> = {}): ProtoDoc {
  return protoDoc([A, B, C, frame('D', 400, 800)], reactions, { variableCollections: collections, ...extra });
}

const scope = (state: TraceState, doc = varDoc(), frameId = 'A') => ({ doc, state, frameId });
const run = (doc: ProtoDoc, state: TraceState, action: TraceAction, layers = screenA) => act(doc, state, action, layers);

// --- Expressions ------------------------------------------------------------------

describe('evaluate', () => {
  const s = start(varDoc(), 'A');

  it.each<{ name: string; expr: VariableExpr; value: VariableLiteral }>([
    { name: 'adds numbers', expr: op('ADDITION', lit(2), lit(3)), value: 5 },
    { name: 'adds more than two numbers', expr: op('ADDITION', lit(1), lit(2), lit(3)), value: 6 },
    { name: 'joins strings', expr: op('ADDITION', lit('Mara'), lit(' Ito')), value: 'Mara Ito' },
    { name: 'adds a number to a string', expr: op('ADDITION', lit('Item '), lit(2)), value: 'Item 2' },
    { name: 'adds a string to a number', expr: op('ADDITION', lit(2), lit(' items')), value: '2 items' },
    { name: 'subtracts', expr: op('SUBTRACTION', lit(5), lit(3)), value: 2 },
    { name: 'multiplies', expr: op('MULTIPLICATION', lit(4), lit(2.5)), value: 10 },
    { name: 'divides', expr: op('DIVISION', lit(9), lit(3)), value: 3 },
    { name: 'compares numbers for equality', expr: op('EQUALS', lit(2), lit(2)), value: true },
    { name: 'compares strings for equality', expr: op('EQUALS', lit('a'), lit('b')), value: false },
    { name: 'compares booleans for equality', expr: op('EQUALS', lit(true), lit(true)), value: true },
    { name: 'compares colors for equality', expr: op('EQUALS', lit(red), lit({ ...red })), value: true },
    { name: 'tells unequal values apart', expr: op('NOT_EQUAL', lit(1), lit(2)), value: true },
    { name: 'less than', expr: op('LESS_THAN', lit(1), lit(2)), value: true },
    { name: 'less than or equal', expr: op('LESS_THAN_OR_EQUAL', lit(2), lit(2)), value: true },
    { name: 'greater than', expr: op('GREATER_THAN', lit(3), lit(2)), value: true },
    { name: 'greater than or equal', expr: op('GREATER_THAN_OR_EQUAL', lit(1), lit(2)), value: false },
    { name: 'and', expr: op('AND', lit(true), lit(false)), value: false },
    { name: 'or', expr: op('OR', lit(false), lit(true)), value: true },
    { name: 'not', expr: op('NOT', lit(true)), value: false },
    { name: 'negates', expr: op('NEGATE', lit(3)), value: -3 },
    { name: 'reads a variable in the default mode', expr: ref('count'), value: 2 },
    { name: 'follows an alias to another variable', expr: ref('total'), value: 2 },
    { name: 'reads a variable in a given mode (VAR_MODE_LOOKUP)', expr: op('VAR_MODE_LOOKUP', ref('count'), lit('dark')), value: 5 },
    { name: 'nests', expr: op('GREATER_THAN', op('MULTIPLICATION', ref('count'), ref('price')), lit(15)), value: true },
  ])('$name', ({ expr, value }) => {
    expect(evaluate(expr, scope(s))).toEqual(value);
  });

  it.each<{ name: string; expr: VariableExpr }>([
    { name: 'a string plus a boolean', expr: op('ADDITION', lit('a'), lit(true)) },
    { name: 'a boolean plus a number', expr: op('ADDITION', lit(true), lit(1)) },
    { name: 'a color plus a number', expr: op('ADDITION', lit(red), lit(1)) },
    { name: 'a string minus a number', expr: op('SUBTRACTION', lit('a'), lit(1)) },
    { name: 'division by zero', expr: op('DIVISION', lit(1), lit(0)) },
    { name: 'AND over a number', expr: op('AND', lit(1), lit(true)) },
    { name: 'NOT of a number', expr: op('NOT', lit(1)) },
    { name: 'negating a string', expr: op('NEGATE', lit('a')) },
    { name: 'ordering strings', expr: op('LESS_THAN', lit('a'), lit('b')) },
    { name: 'comparing a number to a string', expr: op('EQUALS', lit(1), lit('1')) },
    { name: 'NOT with two operands', expr: op('NOT', lit(true), lit(false)) },
    { name: 'ADDITION with one operand', expr: op('ADDITION', lit(1)) },
    { name: 'a variable the prototype does not have', expr: ref('nope') },
    { name: 'a mode lookup with a mode of another collection', expr: op('VAR_MODE_LOOKUP', ref('count'), lit('only')) },
    { name: 'a mode lookup of something other than a variable', expr: op('VAR_MODE_LOOKUP', lit(1), lit('dark')) },
  ])('refuses $name with an ExprError', ({ expr }) => {
    expect(() => evaluate(expr, scope(s))).toThrow(ExprError);
  });

  it('refuses an alias loop', () => {
    const loop = collection('loop', ['m'], [variable('x', 'FLOAT', { m: { alias: 'y' } }), variable('y', 'FLOAT', { m: { alias: 'x' } })]);
    const doc = protoDoc([A], {}, { variableCollections: { loop } });
    expect(() => evaluate(ref('x'), scope(start(doc, 'A'), doc))).toThrow(ExprError);
  });

  describe('which mode a variable is read in', () => {
    it('reads values that SET_VARIABLE assigned, then the document', () => {
      const assigned = { ...s, variables: { ui: { light: { count: 9 } } } };
      expect(evaluate(ref('count'), scope(assigned))).toBe(9);
      expect(evaluate(ref('total'), scope(assigned))).toBe(9);
      expect(evaluate(op('VAR_MODE_LOOKUP', ref('count'), lit('dark')), scope(assigned))).toBe(5);
    });

    it('reads the mode SET_VARIABLE_MODE chose', () => {
      expect(evaluate(ref('count'), scope({ ...s, modes: { ui: 'dark' } }))).toBe(5);
    });

    it("reads the page's explicit mode", () => {
      const doc = varDoc({}, { explicitVariableModes: { ui: 'dark' } });
      expect(evaluate(ref('count'), scope(start(doc, 'A'), doc))).toBe(5);
    });

    it("keeps a frame's explicit mode over the one SET_VARIABLE_MODE chose, as Figma does", () => {
      const doc = protoDoc([frame('A', 400, 800, { explicitVariableModes: { ui: 'light' } })], {}, { variableCollections: collections });
      expect(evaluate(ref('count'), scope({ ...start(doc, 'A'), modes: { ui: 'dark' } }, doc))).toBe(2);
    });
  });
});

// --- Variables ---------------------------------------------------------------------

describe('SET_VARIABLE', () => {
  it('assigns the value in the active mode of the variable collection', () => {
    const doc = varDoc({ btn: [on('ON_CLICK', setVariable('count', op('ADDITION', ref('count'), lit(1))))] });
    const light = run(doc, start(doc, 'A'), click('btn'));
    expect(light.outcome).toBe('changed_state');
    expect(light.state.variables).toEqual({ ui: { light: { count: 3 } } });
    const twice = run(doc, light.state, click('btn'));
    expect(twice.state.variables).toEqual({ ui: { light: { count: 4 } } });

    const dark = run(doc, { ...start(doc, 'A'), modes: { ui: 'dark' } }, click('btn'));
    expect(dark.state.variables).toEqual({ ui: { dark: { count: 6 } } });
  });

  it.each<{ name: string; variableId: string; value: VariableExpr; assigned: VariableLiteral }>([
    { name: 'a joined string', variableId: 'name', value: op('ADDITION', lit('Order '), ref('count')), assigned: 'Order 2' },
    { name: 'a number into a string variable', variableId: 'name', value: lit(5), assigned: '5' },
    { name: 'a comparison into a boolean variable', variableId: 'on', value: op('GREATER_THAN', ref('count'), lit(5)), assigned: false },
    { name: 'a color', variableId: 'tint', value: lit(blue), assigned: blue },
  ])('assigns $name', ({ variableId, value, assigned }) => {
    const doc = varDoc({ btn: [on('ON_CLICK', setVariable(variableId, value))] });
    expect(run(doc, start(doc, 'A'), click('btn')).state.variables).toEqual({ ui: { light: { [variableId]: assigned } } });
  });

  it.each<{ name: string; action: ProtoAction }>([
    { name: 'a string into a number variable', action: setVariable('count', lit('x')) },
    { name: 'a number into a boolean variable', action: setVariable('on', lit(1)) },
    { name: 'a variable the prototype does not have', action: setVariable('nope', lit(1)) },
    { name: 'an expression that fails', action: setVariable('count', op('ADDITION', lit(1), lit(true))) },
  ])('reports $name as unsupported, leaving the variables alone', ({ action }) => {
    const doc = varDoc({ btn: [on('ON_CLICK', action)] });
    const { state, outcome, effects } = run(doc, start(doc, 'A'), click('btn'));
    expect(outcome).toBe('unsupported');
    expect(effects).toEqual([{ type: 'expr_error', action: 'SET_VARIABLE', message: expect.any(String) }]);
    expect(state.variables).toEqual({});
  });

  it('assigning the value a variable already has changes nothing', () => {
    const doc = varDoc({ btn: [on('ON_CLICK', setVariable('count', lit(2)))] });
    const { state, outcome } = run(doc, start(doc, 'A'), click('btn'));
    expect(outcome).toBe('nothing_happened');
    expect(state.variables).toEqual({});
  });
});

describe('SET_VARIABLE_MODE', () => {
  it('sets the mode, and later expressions read in it', () => {
    const doc = varDoc({
      dark: [on('ON_CLICK', setMode('ui', 'dark'))],
      greet: [on('ON_CLICK', setVariable('name', op('ADDITION', lit('n'), ref('count'))))],
    });
    const layers = [...screenA, layer('dark', 'A', [20, 100, 100, 40]), layer('greet', 'A', [20, 200, 100, 40])];
    const switched = run(doc, start(doc, 'A'), click('dark'), layers);
    expect(switched.outcome).toBe('changed_state');
    expect(switched.state.modes).toEqual({ ui: 'dark' });
    expect(run(doc, switched.state, click('greet'), layers).state.variables).toEqual({ ui: { dark: { name: 'n5' } } });
  });

  it.each([
    { name: 'a collection the prototype does not have', action: setMode('nope', 'dark') },
    { name: 'a mode of another collection', action: setMode('ui', 'only') },
  ])('reports $name as unsupported', ({ action }) => {
    const doc = varDoc({ btn: [on('ON_CLICK', action)] });
    const { state, outcome } = run(doc, start(doc, 'A'), click('btn'));
    expect(outcome).toBe('unsupported');
    expect(state.modes).toEqual({});
  });
});

// --- Conditionals --------------------------------------------------------------------

describe('CONDITIONAL', () => {
  const gt = (n: number) => op('GREATER_THAN', ref('count'), lit(n)); // count is 2

  it.each<{ name: string; action: ProtoAction; frameId: string; outcome: string }>([
    { name: 'runs the first true block', action: when([gt(1), navigate('B')], [gt(0), navigate('C')]), frameId: 'B', outcome: 'navigated' },
    { name: 'skips false blocks', action: when([gt(5), navigate('B')], [gt(1), navigate('C')]), frameId: 'C', outcome: 'navigated' },
    { name: 'falls to the else block', action: when([gt(5), navigate('B')], [null, navigate('C')]), frameId: 'C', outcome: 'navigated' },
    { name: 'does nothing when no block is true and there is no else', action: when([gt(5), navigate('B')]), frameId: 'A', outcome: 'nothing_happened' },
  ])('$name', ({ action, frameId, outcome }) => {
    const doc = varDoc({ btn: [on('ON_CLICK', action)] });
    const result = run(doc, start(doc, 'A'), click('btn'));
    expect(result.state.frameId).toBe(frameId);
    expect(result.outcome).toBe(outcome);
  });

  it.each([
    { name: 'a condition that is not a boolean', condition: op('ADDITION', ref('count'), lit(1)) },
    { name: 'a condition with a type error', condition: op('ADDITION', ref('name'), lit(true)) },
  ])('reports $name as unsupported instead of crashing the run', ({ condition }) => {
    const doc = varDoc({ btn: [on('ON_CLICK', when([condition, navigate('B')], [null, navigate('C')]))] });
    const { state, outcome, effects } = run(doc, start(doc, 'A'), click('btn'));
    expect(outcome).toBe('unsupported');
    expect(effects).toEqual([{ type: 'expr_error', action: 'CONDITIONAL', message: expect.any(String) }]);
    expect(state.frameId).toBe('A');
  });

  it('the rest of the reaction still runs after a conditional fails', () => {
    const doc = varDoc({ btn: [on('ON_CLICK', when([lit(1), navigate('B')]), navigate('C'))] });
    const { state, outcome, effects } = run(doc, start(doc, 'A'), click('btn'));
    expect(state.frameId).toBe('C');
    expect(outcome).toBe('navigated');
    expect(effects).toHaveLength(1);
  });
});

// --- Interactive components ----------------------------------------------------------

describe('CHANGE_TO', () => {
  // The instance `tgl` in A shows variant v1; v2 has a link on its label, at path `lbl2`.
  const variants: ProtoVariant[] = [
    { id: 'v1', name: 'State=Off', componentId: 'v1', reactions: { '': [on('ON_CLICK', changeTo('v2'))] } },
    { id: 'v2', name: 'State=On', componentId: 'v2', reactions: { '': [on('ON_CLICK', changeTo('v1'))], lbl2: [on('ON_CLICK', navigate('B'))] } },
    { id: 'v3', name: 'State=Library', componentId: null, reactions: {}, unavailable: true },
  ];
  const doc = (tgl: ProtoReaction[], extra: Record<string, ProtoReaction[]> = {}) =>
    protoDoc([A, B], { tgl, ...extra }, { variantSets: { tgl: { frameId: 'A', variants } } });
  const asV1 = [...screenA, layer('tgl', 'A', [20, 100, 200, 40], { type: 'INSTANCE' }), layer('Itgl;lbl1', 'tgl', [30, 110, 80, 20])];
  const asV2 = [...screenA, layer('tgl', 'A', [20, 100, 200, 40], { type: 'INSTANCE' }), layer('tgl;lbl2', 'tgl', [30, 110, 80, 20])];

  it('sets the override for the instance, under its frame', () => {
    const d = doc([on('ON_CLICK', changeTo('v2'))]);
    const { state, outcome } = run(d, start(d, 'A'), click('tgl'), asV1);
    expect(outcome).toBe('changed_state');
    expect(state.variants).toEqual({ A: { tgl: 'v2' } });
  });

  it("then resolves clicks against the new variant's reactions, by the layers' path keys", () => {
    const d = doc([on('ON_CLICK', changeTo('v2'))]);
    const swapped = run(d, start(d, 'A'), click('tgl'), asV1).state;
    expect(run(d, swapped, click('tgl;lbl2'), asV2).state.frameId).toBe('B');
    const back = run(d, swapped, click('tgl'), asV2);
    expect(back.state.variants).toEqual({ A: { tgl: 'v1' } });
  });

  it('finds the instance from a layer inside it', () => {
    const d = doc([], { 'Itgl;lbl1': [on('ON_CLICK', changeTo('v2'))] });
    expect(run(d, start(d, 'A'), click('Itgl;lbl1'), asV1).state.variants).toEqual({ A: { tgl: 'v2' } });
  });

  it('a variant that is unavailable is unsupported', () => {
    const d = doc([on('ON_CLICK', changeTo('v3'))]);
    const { state, outcome, effects } = run(d, start(d, 'A'), click('tgl'), asV1);
    expect(outcome).toBe('unsupported');
    expect(effects).toEqual([{ type: 'unsupported', action: 'CHANGE_TO' }]);
    expect(state.variants).toEqual({});
  });

  it('a CHANGE_TO to a variant no instance around the trigger has is unsupported, not a misclick', () => {
    const d = doc([], { btn: [on('ON_CLICK', changeTo('v2'))] });
    const { outcome, effects } = run(d, start(d, 'A'), click('btn'), asV1);
    expect(outcome).toBe('unsupported');
    expect(effects).toEqual([{ type: 'unsupported', action: 'missing_variant_set:v2' }]);
  });

  it('a CHANGE_TO with no destination does nothing', () => {
    const d = doc([on('ON_CLICK', node('CHANGE_TO', null))]);
    expect(run(d, start(d, 'A'), click('tgl'), asV1)).toMatchObject({ outcome: 'nothing_happened', effects: [] });
  });

  it('changing a variant clears the overrides of instances nested in the old one', () => {
    const d = doc([on('ON_CLICK', changeTo('v1'))]);
    const s = { ...start(d, 'A'), variants: { A: { tgl: 'v2', 'tgl;badge': 'b2', other: 'o1' } } };
    expect(run(d, s, click('tgl'), asV2).state.variants).toEqual({ A: { tgl: 'v1', other: 'o1' } });
  });

  it('"while pressing" changes the variant back at release', () => {
    const d = doc([on('ON_PRESS', changeTo('v2')), on('ON_CLICK', navigate('B'))]);
    const { state, outcome } = run(d, start(d, 'A'), click('tgl'), asV1);
    expect(outcome).toBe('navigated');
    expect(state.variants).toEqual({});
    expect(state.pointer.held).toEqual([]);
  });

  it('"while hovering" keeps the variant while the pointer is on the instance, and changes it back on leave', () => {
    const d = doc([on('ON_HOVER', changeTo('v2'))]);
    const hovered = run(d, start(d, 'A'), hover('tgl'), asV1);
    expect(hovered.outcome).toBe('changed_state');
    expect(hovered.state.variants).toEqual({ A: { tgl: 'v2' } });
    const onLabel = run(d, hovered.state, hover('tgl;lbl2'), asV2);
    expect(onLabel.state.variants).toEqual({ A: { tgl: 'v2' } });
    const left = run(d, onLabel.state, hover('btn'), asV2);
    expect(left.outcome).toBe('changed_state');
    expect(left.state.variants).toEqual({});
  });

  it('"while hovering" on a layer inside the instance holds over the swapped instance, whose layers have new keys', () => {
    const d = doc([], { 'Itgl;lbl1': [on('ON_HOVER', changeTo('v2'))] });
    const hovered = run(d, start(d, 'A'), hover('Itgl;lbl1'), asV1).state;
    expect(hovered.variants).toEqual({ A: { tgl: 'v2' } });
    expect(run(d, hovered, hover('tgl;lbl2'), asV2).state.variants).toEqual({ A: { tgl: 'v2' } });
  });
});

// --- Keys ------------------------------------------------------------------------------

describe('press_key', () => {
  const press = (key: string): TraceAction => ({ type: 'press_key', key });

  it.each<{ key: string; codes: number[] }>([
    { key: 'Esc', codes: [27] },
    { key: 'Escape', codes: [27] },
    { key: 'Space', codes: [32] },
    { key: 'Spacebar', codes: [32] },
    { key: 'Return', codes: [13] },
    { key: 'Enter', codes: [13] },
    { key: 'Tab', codes: [9] },
    { key: 'Backspace', codes: [8] },
    { key: 'Delete', codes: [46] },
    { key: 'ArrowUp', codes: [38] },
    { key: 'Up', codes: [38] },
    { key: 'Ctrl+K', codes: [17, 75] },
    { key: 'Cmd+K', codes: [91, 75] },
    { key: 'Meta+K', codes: [91, 75] },
    { key: 'Shift+Tab', codes: [16, 9] },
  ])('reads the key name $key as $codes', ({ key, codes }) => {
    expect(keyCodes(key)).toEqual(codes);
  });

  it('accepts every name in KEY_NAMES, alone and after a modifier, and lists the aliases', () => {
    for (const name of KEY_NAMES) {
      expect(keyCodes(name), name).not.toBeNull();
      expect(keyCodes(`Shift+${name}`), name).not.toBeNull();
    }
    for (const modifier of MODIFIER_NAMES) expect(KEY_NAMES).toContain(modifier);
    expect(KEY_NAMES).toEqual(expect.arrayContaining(['Esc', 'Space', 'Return', 'Enter', 'a', 'Z', '7', 'F12', 'ArrowLeft']));
    expect(keyCodes('Hyper')).toBeNull();
    expect(keyCodes('Hyper+K')).toBeNull();
  });

  it.each<{ key: string; codes: number[]; fires: boolean }>([
    { key: 'Enter', codes: [13], fires: true },
    { key: 'Escape', codes: [13], fires: false },
    { key: 'ArrowRight', codes: [39], fires: true },
    { key: ' ', codes: [32], fires: true },
    { key: 'a', codes: [65], fires: true },
    { key: 'A', codes: [65], fires: true },
    { key: '7', codes: [55], fires: true },
    { key: 'Shift+A', codes: [16, 65], fires: true },
    { key: 'a', codes: [16, 65], fires: false },
    { key: 'Control+k', codes: [75, 17], fires: true },
  ])('$key against key codes $codes fires: $fires', ({ key, codes, fires }) => {
    const doc = protoDoc([A, B], { A: [keyDown(codes, navigate('B'))] });
    expect(run(doc, start(doc, 'A'), press(key)).state.frameId).toBe(fires ? 'B' : 'A');
  });

  it('matches keyboard triggers only, not controller buttons', () => {
    const doc = protoDoc([A, B], { A: [keyDown([13], navigate('B'), 'XBOX_ONE')] });
    expect(run(doc, start(doc, 'A'), press('Enter')).outcome).toBe('nothing_happened');
  });

  it('reaches key triggers on any layer of the screen', () => {
    const doc = protoDoc([A, B], { btn: [keyDown([13], navigate('B'))] });
    expect(run(doc, start(doc, 'A'), press('Enter')).state.frameId).toBe('B');
  });

  it('with an overlay open, reaches only its key triggers', () => {
    const M = overlayFrame('M', 200, 100);
    const doc = protoDoc([A, B, C, M], { A: [keyDown([13], navigate('B'))], M: [keyDown([13], navigate('C'))] });
    const s = start(doc, 'A');
    s.overlays = [{ frameId: 'M', position: 'CENTER', origin: { x: 100, y: 350 }, closeOnOutsideClick: false }];
    expect(run(doc, s, press('Enter'), [...screenA, layer('M', null, [100, 350, 200, 100])]).state.frameId).toBe('C');
  });

  it('a key name with no Figma key code is unsupported', () => {
    const doc = protoDoc([A]);
    const { outcome, effects } = run(doc, start(doc, 'A'), press('Hyper'));
    expect(outcome).toBe('unsupported');
    expect(effects).toEqual([{ type: 'unsupported', action: 'press_key Hyper' }]);
  });
});

describe('type', () => {
  const P = overlayFrame('P', 10, 10);
  const field = layer('field', 'A', [20, 300, 200, 40]);
  const layers = [...screenA, field];
  const type = (text: string): TraceAction => ({ type: 'type', element: 'field', text });

  it.each([
    { what: 'without a click first', clicked: null },
    { what: 'after a click elsewhere', clicked: 'btn' },
  ])('focuses the element typed into, then fires its key reactions, $what', ({ clicked }) => {
    const doc = protoDoc([A, P], { field: [keyDown([65], openOverlay('P'))] });
    const s = clicked ? run(doc, start(doc, 'A'), click(clicked), layers).state : start(doc, 'A');
    const typed = run(doc, s, type('mara'), layers);
    expect(typed.outcome).toBe('opened_overlay');
    expect(typed.state.focus).toEqual({ layerKey: 'field', frameId: 'A' });
  });

  it('bubbles a typed key up from the element typed into', () => {
    const doc = protoDoc([A, B], { A: [keyDown([13], navigate('B'))] });
    expect(run(doc, start(doc, 'A'), type('done\n'), layers).state.frameId).toBe('B');
  });

  it('gives typed_nothing when no typed key has a reaction', () => {
    const doc = protoDoc([A, P], { field: [keyDown([65], openOverlay('P'))] });
    expect(run(doc, start(doc, 'A'), type('xyz'), layers).outcome).toBe('typed_nothing');
  });

  it('leaving the frame drops the focus', () => {
    const doc = protoDoc([A, B], { field: [on('ON_CLICK', navigate('B'))] });
    const { state } = run(doc, start(doc, 'A'), click('field'), layers);
    expect(state.frameId).toBe('B');
    expect(state.focus).toBeNull();
  });

  it('a click outside an overlay lands on nothing, so typing goes nowhere', () => {
    const doc = protoDoc([A, P], { field: [keyDown([65], openOverlay('P'))] });
    const M = overlayFrame('M', 200, 100);
    const withM = protoDoc([A, P, M], doc.reactions);
    const focused = run(withM, start(withM, 'A'), click('field'), layers).state;
    focused.overlays = [{ frameId: 'M', position: 'CENTER', origin: { x: 100, y: 350 }, closeOnOutsideClick: false }];
    const outside = run(withM, focused, click('btn'), [...layers, layer('M', null, [100, 350, 200, 100])]).state;
    expect(outside.focus).toBeNull();
  });
});

// --- Timers ------------------------------------------------------------------------------

describe('timers', () => {
  const wait = (seconds: number): TraceAction => ({ type: 'wait', seconds });

  it('start schedules the start frame AFTER_TIMEOUT timers, and settle fires a short one', () => {
    const doc = protoDoc([A, B], { A: [afterDelay(800, navigate('B'))] });
    const s = start(doc, 'A');
    expect(s.timers).toMatchObject([{ layerKey: 'A', frameId: 'A', triggerType: 'AFTER_TIMEOUT', delayMs: 800, dueAtMs: 800 }]);
    const settled = settle(doc, s);
    expect(settled).toMatchObject({ fired: 1, looped: null });
    expect(settled.state).toMatchObject({ frameId: 'B', history: ['A'], clockMs: 800 });
  });

  it.each([
    { delayMs: 2000, fires: true },
    { delayMs: 2001, fires: false },
  ])('settle fires a timer of $delayMs ms: $fires', ({ delayMs, fires }) => {
    const doc = protoDoc([A, B], { A: [afterDelay(delayMs, navigate('B'))] });
    expect(settle(doc, start(doc, 'A')).state.frameId).toBe(fires ? 'B' : 'A');
  });

  it('a timer of 5 s fires on wait(5), or at settle once 2 s or less are left', () => {
    const doc = protoDoc([A, B], { A: [afterDelay(5000, navigate('B'))] });
    const s = settle(doc, start(doc, 'A')).state;
    expect(s.frameId).toBe('A');
    const early = run(doc, s, wait(2));
    expect(early.outcome).toBe('waited');
    expect(early.state.clockMs).toBe(2000);
    expect(settle(doc, early.state).state.frameId).toBe('A');
    const later = run(doc, s, wait(3));
    expect(later.outcome).toBe('waited');
    expect(settle(doc, later.state).state).toMatchObject({ frameId: 'B', clockMs: 5000 });
    const late = run(doc, s, wait(5));
    expect(late.outcome).toBe('timers_fired');
    expect(late.state).toMatchObject({ frameId: 'B', clockMs: 5000 });
  });

  it('settle fires what is due in order of time left, whatever the delays', () => {
    const doc = protoDoc([A, B, C], { A: [afterDelay(5000, navigate('B'))] });
    const s = run(doc, start(doc, 'A'), wait(4.5)).state;
    // A 1 s timer set at 4.5 s comes due after the 5 s one.
    s.timers.push({ layerKey: 'A', chain: ['A'], frameId: 'A', triggerType: 'AFTER_TIMEOUT', delayMs: 1000, dueAtMs: 5500, actions: [navigate('C')], triggerBox: null });
    expect(settle(doc, s).state).toMatchObject({ frameId: 'B', history: ['A'], clockMs: 5000 });
  });

  it('wait reports what its timers did that the screen cannot show', () => {
    const doc = protoDoc([A], { A: [afterDelay(3000, { type: 'URL', url: 'https://example.com/promo' }, { type: 'UPDATE_MEDIA_RUNTIME' })] });
    const { outcome, effects } = run(doc, start(doc, 'A'), wait(5));
    expect(outcome).toBe('timers_fired');
    expect(effects).toEqual([{ type: 'url', url: 'https://example.com/promo' }, { type: 'unsupported', action: 'UPDATE_MEDIA_RUNTIME' }]);
  });

  it('a wait that meets a loop of timers stops at 20, where the loop stood, and reports the frames', () => {
    const doc = protoDoc([A, B], { A: [afterDelay(3000, navigate('B'))], B: [afterDelay(3000, navigate('A'))] });
    const { state, outcome, looped } = run(doc, start(doc, 'A'), wait(1000));
    expect(outcome).toBe('timers_fired');
    expect(looped).toEqual(['A', 'B']);
    expect(state).toMatchObject({ frameId: 'A', clockMs: 60000 });
    expect(state.timers).toMatchObject([{ layerKey: 'A', dueAtMs: 63000 }]);
  });

  it('wait with no timers gives waited and moves the clock', () => {
    const doc = protoDoc([A]);
    const { state, outcome } = run(doc, start(doc, 'A'), wait(3));
    expect(outcome).toBe('waited');
    expect(state.clockMs).toBe(3000);
  });

  it('a frame left during a wait cancels its other timers there and then', () => {
    const doc = protoDoc([A, B, C], { A: [afterDelay(3000, navigate('B')), afterDelay(5000, navigate('C'))] });
    const { state } = run(doc, start(doc, 'A'), wait(6));
    expect(state).toMatchObject({ frameId: 'B', history: ['A'] });
  });

  it('wait fires the timers that come due during it, in order', () => {
    const doc = protoDoc([A, B, C], { A: [afterDelay(3000, navigate('B'))], B: [afterDelay(3000, navigate('C'))] });
    const { state, outcome } = run(doc, start(doc, 'A'), wait(7));
    expect(outcome).toBe('timers_fired');
    expect(state).toMatchObject({ frameId: 'C', history: ['A', 'B'], clockMs: 7000 });
    expect(state.timers).toEqual([]);
  });

  it('a frame shown by navigation starts its timers then', () => {
    const doc = protoDoc([A, B, C], { btn: [on('ON_CLICK', navigate('B'))], B: [afterDelay(5000, navigate('C'))] });
    const s = { ...start(doc, 'A'), clockMs: 1000 };
    const { state } = run(doc, s, click('btn'));
    expect(state.timers).toMatchObject([{ layerKey: 'B', dueAtMs: 6000 }]);
  });

  it('an overlay starts its timers when it opens', () => {
    const toast = overlayFrame('toast', 200, 50);
    const doc = protoDoc([A, toast], { btn: [on('ON_CLICK', openOverlay('toast'))], toast: [afterDelay(1500, { type: 'CLOSE' })] });
    const opened = run(doc, start(doc, 'A'), click('btn')).state;
    expect(opened.overlays.map((o) => o.frameId)).toEqual(['toast']);
    expect(settle(doc, opened).state.overlays).toEqual([]);
  });

  it('leaving a frame cancels its timers, and coming back starts them again', () => {
    const doc = protoDoc([A, B], { btn: [on('ON_CLICK', navigate('B'))], A: [afterDelay(5000, navigate('B'))] });
    const onB = run(doc, start(doc, 'A'), click('btn')).state;
    expect(onB.timers).toEqual([]);
    const back = run(doc, { ...onB, clockMs: 3000 }, { type: 'back' });
    expect(back.state.timers).toMatchObject([{ layerKey: 'A', dueAtMs: 8000 }]);
  });

  it('showing a frame again restarts its timers rather than adding more', () => {
    const doc = protoDoc([A], { btn: [on('ON_CLICK', navigate('A'))], A: [afterDelay(5000, { type: 'BACK' })] });
    const { state } = run(doc, { ...start(doc, 'A'), clockMs: 1000 }, click('btn'));
    expect(state.timers).toMatchObject([{ layerKey: 'A', dueAtMs: 6000 }]);
  });

  it('a loop of short timers stops after 20, keeps the state it reached and reports the frames', () => {
    const doc = protoDoc([A, B], { A: [afterDelay(2000, navigate('B'))], B: [afterDelay(2000, navigate('A'))] });
    const { state, fired, looped } = settle(doc, start(doc, 'A'));
    expect(fired).toBe(20);
    expect(looped).toEqual(['A', 'B']);
    expect(state).toMatchObject({ frameId: 'A', clockMs: 40000 });
    expect(state.history).toHaveLength(20);
    expect(state.timers).toMatchObject([{ layerKey: 'A', dueAtMs: 42000 }]);
  });

  describe('on an interactive component', () => {
    // A carousel instance in A whose variants change to each other after a second.
    const slides: ProtoVariant[] = [
      { id: 's1', name: 'Slide=1', componentId: 's1', reactions: { '': [afterDelay(1000, changeTo('s2'))] } },
      { id: 's2', name: 'Slide=2', componentId: 's2', reactions: { '': [afterDelay(1000, changeTo('s1'))] } },
    ];
    const doc = protoDoc([A, B], { car: [afterDelay(1000, changeTo('s2'))], btn: [on('ON_CLICK', navigate('B'))] }, {
      variantSets: { car: { frameId: 'A', variants: slides } },
    });

    it('starts the shown variant timer with its frame, and the new variant timer after a change', () => {
      const s = start(doc, 'A');
      expect(s.timers).toMatchObject([{ layerKey: 'car', frameId: 'A', dueAtMs: 1000 }]);
      const once = run(doc, s, wait(1));
      expect(once.state.variants).toEqual({ A: { car: 's2' } });
      expect(once.state.timers).toMatchObject([{ layerKey: 'car', dueAtMs: 2000 }]);
    });

    it('times a component nested in a variant only while that variant shows', () => {
      // Slide 2 holds a dot component that changes itself after 1.5 s; slide 1 has no dot.
      const withDot: ProtoVariant[] = [
        slides[0] as ProtoVariant,
        { id: 's2', name: 'Slide=2', componentId: 's2', reactions: { '': [afterDelay(1000, changeTo('s1'))], dot: [afterDelay(1500, changeTo('d2'))] } },
      ];
      const dots: ProtoVariant[] = [
        { id: 'd1', name: 'Dot=1', componentId: 'd1', reactions: {} },
        { id: 'd2', name: 'Dot=2', componentId: 'd2', reactions: {} },
      ];
      const d = protoDoc([A], { car: [afterDelay(1000, changeTo('s2'))] }, {
        variantSets: { car: { frameId: 'A', variants: withDot }, 'car;dot': { frameId: 'A', variants: dots } },
      });
      const s = start(d, 'A');
      expect(s.timers.map((t) => t.layerKey)).toEqual(['car']);
      const onSlide2 = run(d, s, wait(1)).state;
      expect(onSlide2.timers.map((t) => [t.layerKey, t.dueAtMs])).toEqual([
        ['car', 2000],
        ['car;dot', 2500],
      ]);
      // Back on slide 1 at 2 s, the dot is gone, and so is its timer.
      const onSlide1 = run(d, onSlide2, wait(1)).state;
      expect(onSlide1.variants).toEqual({ A: { car: 's1' } });
      expect(onSlide1.timers.map((t) => [t.layerKey, t.dueAtMs])).toEqual([['car', 3000]]);
    });

    it('a change by hand while a timer is pending replaces that timer', () => {
      const d = protoDoc([A], { car: [afterDelay(5000, changeTo('s2')), on('ON_CLICK', changeTo('s2'))] }, {
        variantSets: { car: { frameId: 'A', variants: [slides[0] as ProtoVariant, { id: 's2', name: 'Slide=2', componentId: 's2', reactions: { '': [afterDelay(5000, changeTo('s1'))] } }] } },
      });
      const layers = [...screenA, layer('car', 'A', [0, 100, 400, 200], { type: 'INSTANCE' })];
      const { state } = run(d, { ...start(d, 'A'), clockMs: 1000 }, click('car'), layers);
      expect(state.variants).toEqual({ A: { car: 's2' } });
      expect(state.timers).toMatchObject([{ layerKey: 'car', dueAtMs: 6000 }]);
    });

    it.each([
      { what: 'a MANUAL overlay, as the instance was not measured', action: openOverlay('tip', { overlayRelativePosition: { x: 0, y: 0 } }), name: 'OVERLAY' },
      { what: 'a SCROLL_TO, as settle has no measured screen', action: node('SCROLL_TO', 'car'), name: 'SCROLL_TO' },
    ])("reports what its timer can't place at settle: $what", ({ action, name }) => {
      const tip = overlayFrame('tip', 100, 40, { position: 'MANUAL' });
      const d = protoDoc([A, tip], { car: [afterDelay(500, action)] }, { variantSets: { car: { frameId: 'A', variants: slides } } });
      const { state, effects } = settle(d, start(d, 'A'));
      expect(effects).toEqual([{ type: 'unsupported', action: name }]);
      expect(state.overlays).toEqual([]);
    });

    it('a carousel that never stops is a loop, reported with its frame', () => {
      const { state, fired, looped } = settle(doc, start(doc, 'A'));
      expect(fired).toBe(20);
      expect(looped).toEqual(['A']);
      expect(state.variants).toEqual({ A: { car: 's1' } });
    });
  });
});
