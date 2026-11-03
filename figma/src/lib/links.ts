import { toDashId } from './ids';

export type LinkKind = 'design' | 'file' | 'proto' | 'board' | 'make';

export interface ParsedLink {
  fileKey: string;
  kind: LinkKind;
  /** The human slug after the key, when the link has one. */
  slug: string | null;
}

export type LinkCheck =
  | { ok: true; link: ParsedLink }
  | { ok: false; reason: LinkProblem };

export type LinkProblem =
  | 'empty'
  | 'not_a_link'
  | 'not_figma'
  | 'not_a_design_file'
  | 'wrong_file';

const FIGMA_HOSTS = new Set(['figma.com', 'www.figma.com']);
const KEY = /^[A-Za-z0-9]{10,64}$/;

/**
 * Accepts `figma.com/design/<key>/...`, `figma.com/file/<key>/...` and
 * `figma.com/proto/<key>/...`, with or without the scheme. Branch links
 * (`/design/<key>/branch/<branchKey>/...`) resolve to the branch key, as
 * the prototype viewer does.
 */
export function parseFigmaLink(input: string): LinkCheck {
  const raw = input.trim();
  if (!raw) return { ok: false, reason: 'empty' };
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, reason: 'not_a_link' };
  }
  if (!FIGMA_HOSTS.has(url.hostname.toLowerCase())) {
    return { ok: false, reason: 'not_figma' };
  }
  const parts = url.pathname.split('/').filter(Boolean);
  const kind = parts[0] as LinkKind | undefined;
  if (kind !== 'design' && kind !== 'file' && kind !== 'proto') {
    return { ok: false, reason: 'not_a_design_file' };
  }
  let key = parts[1] ?? '';
  let slug = parts[2] ?? null;
  if (parts[2] === 'branch' && parts[3]) {
    key = parts[3];
    slug = parts[4] ?? null;
  }
  if (!KEY.test(key)) return { ok: false, reason: 'not_a_link' };
  return { ok: true, link: { fileKey: key, kind, slug } };
}

/**
 * Parses a link and, when the plugin knows the open file's key, rejects a
 * link to a different file.
 */
export function checkShareLink(input: string, knownFileKey: string | null | undefined): LinkCheck {
  const parsed = parseFigmaLink(input);
  if (!parsed.ok) return parsed;
  if (knownFileKey && parsed.link.fileKey !== knownFileKey) {
    return { ok: false, reason: 'wrong_file' };
  }
  return parsed;
}

export const LINK_PROBLEM_TEXT: Record<LinkProblem, string> = {
  empty: 'Paste the share link of this file.',
  not_a_link: 'That does not look like a Figma link.',
  not_figma: 'Use a figma.com link to this file.',
  not_a_design_file: 'Use the link of a design file or prototype, not a FigJam board or a Make file.',
  wrong_file: 'That link points to a different file. Copy the link of the file you have open.',
};

/** A URL safe slug for the prototype path; Figma ignores it, people read it. */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'Prototype';
}

/**
 * The prototype share link the runner opens, written the way Figma writes
 * it: `node-id` (dash form) first, then `starting-point-node-id` (colon form,
 * URL encoded), then `scaling`.
 */
export function buildProtoUrl(fileKey: string, startNodeId: string, fileName: string): string {
  const dash = toDashId(startNodeId);
  const colon = dash.replace('-', ':');
  return (
    `https://www.figma.com/proto/${fileKey}/${slugify(fileName)}` +
    `?node-id=${dash}&starting-point-node-id=${encodeURIComponent(colon)}&scaling=scale-down`
  );
}
