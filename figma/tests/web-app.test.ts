import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, isLocalUrl, webAppMismatch } from '../src/lib/messages';

const LOCAL_API = 'http://localhost:5013';
const LOCAL_WEB = 'http://localhost:5173';

describe('the web app Open in Archetype goes to', () => {
  it('tells a local address from a server', () => {
    for (const url of ['http://localhost:5013', 'http://127.0.0.1:5173/', 'http://[::1]:5013', 'https://localhost']) expect(isLocalUrl(url), url).toBe(true);
    for (const url of ['https://api.syntheticarchetype.com', 'https://www.syntheticarchetype.com', 'https://localhost.example.com', 'http://localhostile.dev']) expect(isLocalUrl(url), url).toBe(false);
  });

  it('must be on this computer when the API is: the tests live there', () => {
    expect(webAppMismatch({ apiBase: LOCAL_API, webBase: DEFAULT_SETTINGS.webBase })).toBe(
      "Your API is on this computer, so tests live there; Open in Archetype needs the local web app too (demo-local's ./start.sh --with-web serves it on http://localhost:5173).",
    );
  });

  it("must not be on this computer when the API isn't", () => {
    expect(webAppMismatch({ apiBase: DEFAULT_SETTINGS.apiBase, webBase: LOCAL_WEB })).toBe(
      `Your API isn't on this computer, so tests live on that server; Open in Archetype needs its web app too, not the one on this computer (Archetype's is ${DEFAULT_SETTINGS.webBase}).`,
    );
  });

  it('is fine when both are local or both are servers', () => {
    expect(webAppMismatch({ apiBase: LOCAL_API, webBase: LOCAL_WEB })).toBeNull();
    expect(webAppMismatch(DEFAULT_SETTINGS)).toBeNull();
    expect(webAppMismatch({ apiBase: 'https://api.staging.example.com', webBase: 'https://app.staging.example.com' })).toBeNull();
  });
});
