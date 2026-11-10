/** Content comparison for plain data: JSON with sorted keys, and a short hash of it. */

/**
 * Plain data as JSON with object keys sorted, so two values with the same
 * content give the same text. ES2017 only: the main thread's sandbox runs it.
 */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(v).sort()) sorted[key] = (v as Record<string, unknown>)[key];
    return sorted;
  });
}

/** A 53 bit hash of the text (cyrb53), as 14 hex digits. Not cryptographic: it notices changes. */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}
