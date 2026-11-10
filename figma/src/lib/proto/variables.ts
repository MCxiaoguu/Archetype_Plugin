/**
 * Variables in prototype actions: SET_VARIABLE, SET_VARIABLE_MODE and the
 * choice of a CONDITIONAL's block. Each throws an ExprError when the
 * document's variables don't allow the action, for the engine to report.
 */

import { activeMode, evaluate, ExprError, type ExprScope, findVariable, readVariable, sameLiteral, typeOf } from './expr';
import type { ConditionalBlock, VariableDef, VariableExpr, VariableLiteral } from './model';

/** The value as the variable's type takes it: a number joins a string variable as text, as in Figma's string expressions. */
function asType(def: VariableDef, value: VariableLiteral): VariableLiteral {
  const type = typeOf(value);
  if (def.resolvedType === 'STRING' && type === 'number') return `${value}`;
  const wanted = { BOOLEAN: 'boolean', FLOAT: 'number', STRING: 'string', COLOR: 'color' }[def.resolvedType];
  if (type !== wanted) throw new ExprError(`Can't set ${def.name}, a ${wanted} variable, to a ${type}`);
  return value;
}

/** SET_VARIABLE: evaluates the expression and assigns the result in the variable's active mode. */
export function assignVariable(scope: ExprScope, variableId: string, value: VariableExpr): void {
  const { collection, def } = findVariable(scope.doc, variableId);
  const result = asType(def, evaluate(value, scope));
  const modeId = activeMode(scope, collection);
  if (sameLiteral(readVariable(scope, variableId, modeId), result)) return;
  const variables = scope.state.variables;
  const modes = (variables[collection.id] = variables[collection.id] ?? {});
  const values = (modes[modeId] = modes[modeId] ?? {});
  values[variableId] = result;
}

/** SET_VARIABLE_MODE: the page's mode for the collection. */
export function setVariableMode(scope: ExprScope, collectionId: string, modeId: string): void {
  const collection = scope.doc.variableCollections[collectionId];
  if (!collection) throw new ExprError(`Variable collection ${collectionId} isn't among the prototype's variables`);
  if (!collection.modes.some((m) => m.modeId === modeId)) {
    throw new ExprError(`${modeId} isn't a mode of the variable collection ${collection.name}`);
  }
  const current = scope.state.modes[collectionId] ?? scope.doc.explicitVariableModes[collectionId] ?? collection.defaultModeId;
  if (current !== modeId) scope.state.modes[collectionId] = modeId;
}

/** The first block whose condition is true; a block without a condition is the else block. Null when none applies. */
export function conditionalBlock(scope: ExprScope, blocks: ConditionalBlock[]): ConditionalBlock | null {
  for (const block of blocks) {
    if (block.condition === null) return block;
    const value = evaluate(block.condition, scope);
    if (typeof value !== 'boolean') throw new ExprError(`A condition gave a ${typeOf(value)}, not true or false`);
    if (value) return block;
  }
  return null;
}
