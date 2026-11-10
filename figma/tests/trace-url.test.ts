import { describe, expect, it } from 'vitest';
import { nodeIdFromUrl } from '../src/lib/ids';
import { parseStepUrl, stepUrl } from '../src/lib/proto/url';

describe('stepUrl', () => {
  it('builds a figma-trace:// URL when there is no share key', () => {
    expect(stepUrl(null, 'My Page', { frameId: '2:20', overlays: ['3:1'] })).toBe(
      'figma-trace://My%20Page/2-20?node-id=2-20&overlay=3-1',
    );
  });

  it('builds a figma.com proto URL with a share key', () => {
    expect(stepUrl('AbCdEfGh1234567890XyZ', 'My Page', { frameId: '2:20', overlays: ['3:1'] })).toBe(
      'https://www.figma.com/proto/AbCdEfGh1234567890XyZ/My%20Page?node-id=2-20&overlay=3-1',
    );
  });

  it('omits the overlay parameter with no open overlays', () => {
    expect(stepUrl(null, 'My Page', { frameId: '2:20', overlays: [] })).toBe(
      'figma-trace://My%20Page/2-20?node-id=2-20',
    );
  });

  it('joins several open overlays with commas', () => {
    expect(stepUrl(null, 'My Page', { frameId: '2:20', overlays: ['3:1', '5:2'] })).toBe(
      'figma-trace://My%20Page/2-20?node-id=2-20&overlay=3-1,5-2',
    );
  });
});

describe('parseStepUrl', () => {
  it('round-trips the figma-trace:// form', () => {
    const url = stepUrl(null, 'My Page', { frameId: '2:20', overlays: ['3:1', '5:2'] });
    expect(parseStepUrl(url)).toEqual({ shareKey: null, pageName: 'My Page', frameId: '2:20', overlays: ['3:1', '5:2'] });
  });

  it('round-trips the figma.com proto form', () => {
    const url = stepUrl('AbCdEfGh1234567890XyZ', 'My Page', { frameId: '2:20', overlays: ['3:1'] });
    expect(parseStepUrl(url)).toEqual({
      shareKey: 'AbCdEfGh1234567890XyZ',
      pageName: 'My Page',
      frameId: '2:20',
      overlays: ['3:1'],
    });
  });

  it('round-trips a step with no open overlays', () => {
    const url = stepUrl(null, 'Prototype', { frameId: '2:20', overlays: [] });
    expect(parseStepUrl(url)).toEqual({ shareKey: null, pageName: 'Prototype', frameId: '2:20', overlays: [] });
  });

  it('returns null for a URL with no node-id', () => {
    expect(parseStepUrl('https://www.figma.com/proto/KEY/My%20Page')).toBeNull();
    expect(parseStepUrl('not a url')).toBeNull();
  });
});

describe('nodeIdFromUrl reads the frame from both step URL forms', () => {
  it('reads the figma-trace:// form', () => {
    const url = stepUrl(null, 'My Page', { frameId: '2:20', overlays: ['3:1'] });
    expect(nodeIdFromUrl(url)).toBe('2:20');
  });

  it('reads the figma.com proto form', () => {
    const url = stepUrl('AbCdEfGh1234567890XyZ', 'My Page', { frameId: '2:20', overlays: ['3:1'] });
    expect(nodeIdFromUrl(url)).toBe('2:20');
  });
});
