/**
 * The URL a trace step is "on". With a share link it's a real prototype
 * link; without one (plugin mode needs no link) it's a `figma-trace://`
 * URL the panel invents, which `_safe_url` on the backend shows as plain
 * text rather than a broken link. The page name is percent-encoded with
 * `encodeURIComponent`, because `new URL("figma-trace://My Page/…")` throws
 * on the unencoded space and the panel's `nodeIdFromUrl` would lose the
 * persona's screen.
 */

import { toColonId, toDashId } from '../ids';

export interface StepUrlState {
  frameId: string;
  /** Ids of every overlay currently open, topmost last. */
  overlays: string[];
}

export interface ParsedStepUrl {
  /** Null when the URL has no share key (the `figma-trace://` form). */
  shareKey: string | null;
  pageName: string;
  frameId: string;
  overlays: string[];
}

function query(frameId: string, overlays: string[]): string {
  const frame = toDashId(frameId);
  const overlayIds = overlays.map(toDashId);
  const overlayParam = overlayIds.length ? `&overlay=${overlayIds.join(',')}` : '';
  return `?node-id=${frame}${overlayParam}`;
}

/**
 * The URL for a step on `frameId` with the given open overlays: a real
 * `figma.com/proto` link when `shareKey` is given, otherwise the
 * `figma-trace://<page>/<frame>?…` form. Putting the frame in the path of
 * the `figma-trace://` form gives `_page_key` (host plus path) one page
 * per frame, so pages visited and backtracks mean something for these runs.
 */
export function stepUrl(shareKey: string | null, pageName: string, step: StepUrlState): string {
  const page = encodeURIComponent(pageName);
  const q = query(step.frameId, step.overlays);
  if (shareKey) {
    return `https://www.figma.com/proto/${shareKey}/${page}${q}`;
  }
  const frame = toDashId(step.frameId);
  return `figma-trace://${page}/${frame}${q}`;
}

/** The inverse of `stepUrl`, for either form. Null when the URL can't be read. */
export function parseStepUrl(url: string): ParsedStepUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const nodeId = parsed.searchParams.get('node-id');
  if (!nodeId) return null;

  try {
    const frameId = toColonId(nodeId);
    const overlayParam = parsed.searchParams.get('overlay');
    const overlays = overlayParam ? overlayParam.split(',').map(toColonId) : [];

    if (parsed.protocol === 'figma-trace:') {
      return { shareKey: null, pageName: decodeURIComponent(parsed.hostname), frameId, overlays };
    }

    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'proto' || !parts[1] || !parts[2]) return null;
    return { shareKey: parts[1], pageName: decodeURIComponent(parts[2]), frameId, overlays };
  } catch {
    return null;
  }
}
