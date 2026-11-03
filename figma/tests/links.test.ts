import { describe, expect, it } from 'vitest';
import { buildProtoUrl, checkShareLink, parseFigmaLink, slugify } from '../src/lib/links';

const KEY = 'vKlEYIkcpOjpLLNpAIOY6F';

describe('share link parsing', () => {
  it.each([
    [`https://www.figma.com/design/${KEY}/HCI-first-prototype?node-id=0-1&t=abc`, 'design'],
    [`https://www.figma.com/file/${KEY}/HCI-first-prototype`, 'file'],
    [`https://www.figma.com/proto/${KEY}/HCI-first-prototype?node-id=1-3`, 'proto'],
    [`figma.com/design/${KEY}/HCI`, 'design'],
    [`  https://figma.com/proto/${KEY}  `, 'proto'],
  ])('accepts %s', (url, kind) => {
    const r = parseFigmaLink(url);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.link.fileKey).toBe(KEY);
      expect(r.link.kind).toBe(kind);
    }
  });

  it('uses the branch key of branch links', () => {
    const r = parseFigmaLink(`https://www.figma.com/design/${KEY}/branch/BrAnChKeY12345/Name`);
    expect(r.ok && r.link.fileKey).toBe('BrAnChKeY12345');
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['https://example.com/design/abc', 'not_figma'],
    [`https://www.figma.com/board/${KEY}/Board`, 'not_a_design_file'],
    [`https://www.figma.com/make/${KEY}/App`, 'not_a_design_file'],
    ['https://www.figma.com/design/', 'not_a_link'],
    ['https://www.figma.com/design/short/x', 'not_a_link'],
    ['http://[bad', 'not_a_link'],
  ])('rejects %j as %s', (url, reason) => {
    const r = parseFigmaLink(url);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe(reason);
  });

  it('rejects a link to another file when the key is known', () => {
    const r = checkShareLink(`https://www.figma.com/design/${KEY}/x`, 'OtherKey123456789');
    expect(r).toEqual({ ok: false, reason: 'wrong_file' });
    expect(checkShareLink(`https://www.figma.com/design/${KEY}/x`, KEY).ok).toBe(true);
    expect(checkShareLink(`https://www.figma.com/design/${KEY}/x`, null).ok).toBe(true);
  });
});

describe('prototype URL', () => {
  it('puts node-id first and the encoded starting point second', () => {
    expect(buildProtoUrl(KEY, '1:3', 'HCI first prototype')).toBe(
      `https://www.figma.com/proto/${KEY}/HCI-first-prototype?node-id=1-3&starting-point-node-id=1%3A3&scaling=scale-down`,
    );
  });

  it('slugs file names safely', () => {
    expect(slugify('Café / Checkout v2!')).toBe('Cafe-Checkout-v2');
    expect(slugify('***')).toBe('Prototype');
    expect(slugify('a'.repeat(100))).toHaveLength(60);
  });

});
