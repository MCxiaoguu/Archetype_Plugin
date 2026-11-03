/**
 * Figma node ids come in two spellings. The Plugin API uses a colon
 * ("71:616"); prototype and design URLs use a dash ("71-616") in the
 * `node-id` query parameter. Instance children add a semicolon path
 * ("I71:616;12:3"), which never appears in prototype URLs.
 */

const COLON_ID = /^I?\d+:\d+(;I?\d+:\d+)*$/;
const DASH_ID = /^\d+-\d+$/;

export function isColonId(id: string): boolean {
  return COLON_ID.test(id);
}

export function isDashId(id: string): boolean {
  return DASH_ID.test(id);
}

/** "71:616" to "71-616". Dash ids pass through unchanged. */
export function toDashId(id: string): string {
  const trimmed = id.trim();
  if (DASH_ID.test(trimmed)) return trimmed;
  if (!/^\d+:\d+$/.test(trimmed)) {
    throw new Error(`Not a top level node id: ${id}`);
  }
  return trimmed.replace(':', '-');
}

/** "71-616" (or "71%3A616", or "71:616") to "71:616". */
export function toColonId(id: string): string {
  let trimmed = id.trim();
  try {
    trimmed = decodeURIComponent(trimmed);
  } catch {
    // keep the raw value; the checks below reject it if it is malformed
  }
  if (/^\d+:\d+$/.test(trimmed)) return trimmed;
  if (DASH_ID.test(trimmed)) return trimmed.replace('-', ':');
  throw new Error(`Not a node id: ${id}`);
}

/**
 * Reads the `node-id` of a prototype or design URL and returns it in colon
 * form, or null when the URL has none (or is not a URL at all).
 */
export function nodeIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const raw = parsed.searchParams.get('node-id');
  if (!raw) return null;
  try {
    return toColonId(raw);
  } catch {
    return null;
  }
}
