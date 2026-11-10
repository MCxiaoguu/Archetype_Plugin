/**
 * Prototype variable expressions, evaluated by the rules Figma documents
 * for them ("Use expressions in prototypes"): + adds numbers and joins
 * strings, and a number joins a string as text; the other arithmetic takes
 * numbers; the orderings take numbers and equality compares like with
 * like; AND, OR and NOT take booleans. Anything else is an ExprError:
 * nothing is coerced silently.
 */

import { EngineError } from './errors';
import type {
  ProtoDoc,
  RGBA,
  TraceState,
  VariableCollection,
  VariableDef,
  VariableExpr,
  VariableExprOperator,
  VariableLiteral,
  VariableValue,
} from './model';

export class ExprError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExprError';
  }
}

export interface ExprScope {
  doc: ProtoDoc;
  state: TraceState;
  /** The top level frame the trigger is in: its explicit modes win over the page's. */
  frameId: string;
}

type ValueType = 'number' | 'string' | 'boolean' | 'color';

export function typeOf(value: VariableLiteral): ValueType {
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return typeof value as ValueType;
  return 'color';
}

const isAlias = (value: VariableValue): value is { alias: string } => typeof value === 'object' && 'alias' in value;

/** Equal values of one type; values of two types are simply not equal. */
export function sameLiteral(a: VariableLiteral, b: VariableLiteral): boolean {
  if (typeOf(a) !== typeOf(b)) return false;
  if (typeOf(a) !== 'color') return a === b;
  const [x, y] = [a as RGBA, b as RGBA];
  return x.r === y.r && x.g === y.g && x.b === y.b && x.a === y.a;
}

export function findVariable(doc: ProtoDoc, variableId: string): { collection: VariableCollection; def: VariableDef } {
  for (const collection of Object.values(doc.variableCollections)) {
    const def = collection.variables[variableId];
    if (def) return { collection, def };
  }
  throw new ExprError(`Variable ${variableId} isn't among the prototype's variables`);
}

/**
 * The mode a collection is read in: the trigger frame's explicit mode, as
 * an explicit mode on an object wins over the page's in Figma; else the
 * one SET_VARIABLE_MODE chose for the page; else the page's explicit
 * mode; else the collection's default.
 */
export function activeMode(scope: ExprScope, collection: VariableCollection): string {
  const frame = scope.doc.frames.find((f) => f.id === scope.frameId);
  if (!frame) throw new EngineError('invalid_doc', `The frame ${scope.frameId} isn't in the prototype`);
  return (
    frame.explicitVariableModes[collection.id] ??
    scope.state.modes[collection.id] ??
    scope.doc.explicitVariableModes[collection.id] ??
    collection.defaultModeId
  );
}

/** A variable's value in `modeId` (its active mode when null): what SET_VARIABLE assigned, else the document's, through aliases. */
export function readVariable(scope: ExprScope, variableId: string, modeId: string | null, chain: string[] = []): VariableLiteral {
  if (chain.includes(variableId)) throw new ExprError(`Variable ${variableId} is an alias of itself`);
  const { collection, def } = findVariable(scope.doc, variableId);
  const mode = modeId ?? activeMode(scope, collection);
  if (!collection.modes.some((m) => m.modeId === mode)) {
    throw new ExprError(`${mode} isn't a mode of the variable collection ${collection.name}`);
  }
  const assigned = scope.state.variables[collection.id]?.[mode]?.[variableId];
  if (assigned !== undefined) return assigned;
  const value = def.valuesByMode[mode];
  if (value === undefined) throw new ExprError(`Variable ${def.name} has no value in mode ${mode}`);
  return isAlias(value) ? readVariable(scope, value.alias, null, [...chain, variableId]) : value;
}

export function evaluate(expr: VariableExpr, scope: ExprScope): VariableLiteral {
  switch (expr.kind) {
    case 'literal':
      return expr.value;
    case 'alias':
      return readVariable(scope, expr.variableId, null);
    case 'op':
      return operate(expr.operator, expr.operands, scope);
  }
}

function arity(operator: VariableExprOperator, operands: VariableExpr[], min: number, max = min): void {
  if (operands.length < min || operands.length > max) {
    const wanted = min === max ? `${min}` : `${min} or more`;
    throw new ExprError(`${operator} takes ${wanted} operands, not ${operands.length}`);
  }
}

function numbers(operator: VariableExprOperator, values: VariableLiteral[]): number[] {
  return values.map((v) => {
    if (typeof v !== 'number') throw new ExprError(`${operator} takes numbers, not a ${typeOf(v)}`);
    return v;
  });
}

function booleans(operator: VariableExprOperator, values: VariableLiteral[]): boolean[] {
  return values.map((v) => {
    if (typeof v !== 'boolean') throw new ExprError(`${operator} takes true or false, not a ${typeOf(v)}`);
    return v;
  });
}

function add(a: VariableLiteral, b: VariableLiteral): VariableLiteral {
  if (typeof a === 'number' && typeof b === 'number') return a + b;
  const joins = (v: VariableLiteral) => typeof v === 'string' || typeof v === 'number';
  if ((typeof a === 'string' || typeof b === 'string') && joins(a) && joins(b)) return `${a}${b}`;
  throw new ExprError(`Can't add a ${typeOf(a)} and a ${typeOf(b)}`);
}

function equal(a: VariableLiteral, b: VariableLiteral): boolean {
  if (typeOf(a) !== typeOf(b)) throw new ExprError(`Can't compare a ${typeOf(a)} with a ${typeOf(b)}`);
  return sameLiteral(a, b);
}

function operate(operator: VariableExprOperator, operands: VariableExpr[], scope: ExprScope): VariableLiteral {
  if (operator === 'VAR_MODE_LOOKUP') {
    // A variable and the id of one of its collection's modes: the variable's value in that mode.
    arity(operator, operands, 2);
    const [variable, mode] = operands as [VariableExpr, VariableExpr];
    if (variable.kind !== 'alias') throw new ExprError('VAR_MODE_LOOKUP takes a variable, then a mode');
    const modeId = evaluate(mode, scope);
    if (typeof modeId !== 'string') throw new ExprError(`VAR_MODE_LOOKUP takes a mode id, not a ${typeOf(modeId)}`);
    return readVariable(scope, variable.variableId, modeId);
  }

  const values = operands.map((o) => evaluate(o, scope));
  switch (operator) {
    case 'ADDITION':
      arity(operator, operands, 2, Infinity);
      return values.reduce(add);
    case 'SUBTRACTION':
      arity(operator, operands, 2, Infinity);
      return numbers(operator, values).reduce((a, b) => a - b);
    case 'MULTIPLICATION':
      arity(operator, operands, 2, Infinity);
      return numbers(operator, values).reduce((a, b) => a * b);
    case 'DIVISION':
      arity(operator, operands, 2, Infinity);
      return numbers(operator, values).reduce((a, b) => {
        if (b === 0) throw new ExprError('Division by zero');
        return a / b;
      });
    case 'EQUALS':
      arity(operator, operands, 2);
      return equal(values[0] as VariableLiteral, values[1] as VariableLiteral);
    case 'NOT_EQUAL':
      arity(operator, operands, 2);
      return !equal(values[0] as VariableLiteral, values[1] as VariableLiteral);
    case 'LESS_THAN':
    case 'LESS_THAN_OR_EQUAL':
    case 'GREATER_THAN':
    case 'GREATER_THAN_OR_EQUAL': {
      arity(operator, operands, 2);
      const [a, b] = numbers(operator, values) as [number, number];
      if (operator === 'LESS_THAN') return a < b;
      if (operator === 'LESS_THAN_OR_EQUAL') return a <= b;
      if (operator === 'GREATER_THAN') return a > b;
      return a >= b;
    }
    case 'AND':
      arity(operator, operands, 2, Infinity);
      return booleans(operator, values).every(Boolean);
    case 'OR':
      arity(operator, operands, 2, Infinity);
      return booleans(operator, values).some(Boolean);
    case 'NOT':
      arity(operator, operands, 1);
      return !booleans(operator, values)[0];
    case 'NEGATE':
      arity(operator, operands, 1);
      return 0 - (numbers(operator, values)[0] as number);
  }
}
