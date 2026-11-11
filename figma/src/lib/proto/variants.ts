/**
 * Interactive components. CHANGE_TO sets an override variant on an
 * instance; from then on the instance's layers are measured with path
 * keys (`<instance key>;<path>`, see `RawLayer.key`), and their reactions
 * are the new variant's, by path.
 */

import { EngineError } from './errors';
import type { ProtoDoc, ProtoReaction, ProtoVariant, TraceState } from './model';

export interface VariantChange {
  frameId: string;
  instanceKey: string;
  /** The override before the change; null when there was none. */
  previous: string | null;
}

export function variantOf(doc: ProtoDoc, instanceKey: string, variantId: string): ProtoVariant {
  const variant = doc.variantSets[instanceKey]?.variants.find((v) => v.id === variantId);
  if (!variant) throw new EngineError('invalid_doc', `Variant ${variantId} of instance ${instanceKey} isn't in the prototype`);
  return variant;
}

/** The innermost overridden instance at or around `layerKey`, and the layer's path inside its variant. */
function swappedAround(doc: ProtoDoc, s: Pick<TraceState, 'variants'>, layerKey: string): { variant: ProtoVariant; path: string } | null {
  let found: { instanceKey: string; variantId: string } | null = null;
  for (const overrides of Object.values(s.variants)) {
    for (const [instanceKey, variantId] of Object.entries(overrides)) {
      if (layerKey !== instanceKey && !layerKey.startsWith(`${instanceKey};`)) continue;
      if (found && found.instanceKey.length >= instanceKey.length) continue;
      found = { instanceKey, variantId };
    }
  }
  if (!found) return null;
  const path = layerKey === found.instanceKey ? '' : layerKey.slice(found.instanceKey.length + 1);
  return { variant: variantOf(doc, found.instanceKey, found.variantId), path };
}

/** A layer's reactions: its variant's when it is (or is inside) an instance with an override, the document's otherwise. */
export function reactionsFor(doc: ProtoDoc, s: Pick<TraceState, 'variants'>, layerKey: string): ProtoReaction[] {
  const swapped = swappedAround(doc, s, layerKey);
  if (swapped) return swapped.variant.reactions[swapped.path] ?? [];
  return doc.reactions[layerKey] ?? [];
}

/** The instance a CHANGE_TO from a layer with this chain changes: the innermost one whose variant set has the variant. */
export function instanceFor(doc: ProtoDoc, chain: string[], variantId: string): { instanceKey: string; frameId: string; variant: ProtoVariant } | null {
  for (const key of chain) {
    const set = doc.variantSets[key];
    const variant = set?.variants.find((v) => v.id === variantId);
    if (set && variant) return { instanceKey: key, frameId: set.frameId, variant };
  }
  return null;
}

/** The interactive components in a top level frame. */
export function instancesIn(doc: ProtoDoc, frameId: string): string[] {
  return Object.keys(doc.variantSets).filter((key) => doc.variantSets[key]?.frameId === frameId);
}

/**
 * Whether `key` names a layer inside the instance `instanceKey`: under
 * its path keys (`<instance>;<path>`), or under Figma's own ids for the
 * layers of an instance showing its main component (`I<instance>;<path>`).
 */
export function isInside(instanceKey: string, key: string): boolean {
  return key.startsWith(`${instanceKey};`) || (!instanceKey.startsWith('I') && key.startsWith(`I${instanceKey};`));
}

/**
 * Sets (or, with null, clears) an instance's override. The overrides of
 * instances inside it go with it: those layers are gone. Returns whether
 * it changed.
 */
export function setOverride(s: TraceState, frameId: string, instanceKey: string, variantId: string | null): boolean {
  const overrides = s.variants[frameId] ?? {};
  if ((overrides[instanceKey] ?? null) === variantId) return false;
  for (const key of Object.keys(overrides)) if (isInside(instanceKey, key)) delete overrides[key];
  if (variantId === null) delete overrides[instanceKey];
  else overrides[instanceKey] = variantId;
  if (Object.keys(overrides).length) s.variants[frameId] = overrides;
  else delete s.variants[frameId];
  return true;
}

/** The overrides that differ between two states of `TraceState.variants`, with what each was before. */
export function variantChanges(before: TraceState['variants'], after: TraceState['variants']): VariantChange[] {
  const changes: VariantChange[] = [];
  for (const frameId of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const was = before[frameId] ?? {};
    const is = after[frameId] ?? {};
    for (const instanceKey of new Set([...Object.keys(was), ...Object.keys(is)])) {
      if (was[instanceKey] !== is[instanceKey]) changes.push({ frameId, instanceKey, previous: was[instanceKey] ?? null });
    }
  }
  return changes;
}
