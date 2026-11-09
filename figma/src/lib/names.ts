/**
 * Layer names that tell nobody what a hotspot does. The prototype viewer's
 * screen reader mode exposes a hotspot as a link named after its layer, so a
 * persona (and a screen reader user) hears "link Rectangle 12".
 */

export type GenericReason = 'default' | 'file' | 'export' | 'empty';

const DEFAULT_NAMES = [
  'rectangle', 'ellipse', 'frame', 'group', 'vector', 'line', 'polygon', 'star', 'arrow',
  'image', 'union', 'subtract', 'intersect', 'exclude', 'instance', 'component', 'section',
  'slice', 'text', 'mask group', 'layer', 'shape', 'container', 'auto layout', 'boolean',
  'path', 'oval', 'combined shape', 'untitled', 'button', 'icon',
];
const DEFAULT_RE = new RegExp(
  `^(${DEFAULT_NAMES.join('|')})( \\d+)?( copy( \\d+)?)?$`,
  'i',
);
const FILE_RE = /\.(png|jpe?g|gif|svg|webp|heic|avif|pdf|tiff?)$/i;
const EXPORT_RES = [
  /^icons8[-_ ]/i,
  /^noun[-_ ]/i,
  /^(pexels|unsplash|shutterstock|istock|adobestock|freepik|pixabay)[-_ ]/i,
  /^(img|dsc|pxl)[-_]?\d+/i,
  /^screen ?shot\b/i,
  /^ic_[a-z0-9_]+$/i,
  /^\d+$/,
  // slugs with a size or id and a duplicate counter, like "trophy-32 1"
  /^(?=[^ ]*\d)[a-z0-9]+(?:[-_][a-z0-9]+)+ \d+$/i,
];

export function genericNameReason(name: string | null | undefined): GenericReason | null {
  const n = (name ?? '').trim();
  if (!n) return 'empty';
  if (DEFAULT_RE.test(n)) return 'default';
  if (FILE_RE.test(n)) return 'file';
  if (EXPORT_RES.some((re) => re.test(n))) return 'export';
  return null;
}

export function isGenericLayerName(name: string | null | undefined): boolean {
  return genericNameReason(name) !== null;
}

/** A short, human suggestion for a better name. */
export function suggestName(textHint: string | null | undefined): string | null {
  const t = (textHint ?? '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 40 || isGenericLayerName(t)) return null;
  return t;
}
