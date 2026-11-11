import { useState } from 'preact/hooks';
import { DEFAULT_SETTINGS, isSafeWebUrl, webAppMismatch } from '../../lib/messages';
import type { AppState } from '../../lib/state';
import type { Effects } from '../effects';
import { Banner, Field } from '../parts';

export function SettingsScreen({ state, fx }: { state: AppState; fx: Effects }) {
  const [apiBase, setApi] = useState(state.settings.apiBase);
  const [webBase, setWeb] = useState(state.settings.webBase);
  const [token, setToken] = useState('');
  const valid = (u: string) => isSafeWebUrl(u.trim());
  return (
    <form
      class="screen settings"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (valid(apiBase) && valid(webBase)) fx.saveSettings({ apiBase: apiBase.trim(), webBase: webBase.trim() });
      }}
    >
      <div class="scroll">
        <h1 class="screen-title">Settings</h1>
        {state.notice && <Banner kind={state.notice.kind}>{state.notice.text}</Banner>}
        <Field id="api" label="Archetype API" error={valid(apiBase) ? undefined : 'Use a full https address (http only for localhost).'} hint={`Default ${DEFAULT_SETTINGS.apiBase}`}>
          {(aria) => <input {...aria} type="url" value={apiBase} onInput={(e) => setApi((e.currentTarget as HTMLInputElement).value)} />}
        </Field>
        <Field id="web" label="Archetype web app" error={valid(webBase) ? undefined : 'Use a full https address (http only for localhost).'} hint="Where Open in Archetype goes.">
          {(aria) => <input {...aria} type="url" value={webBase} onInput={(e) => setWeb((e.currentTarget as HTMLInputElement).value)} />}
        </Field>
        {valid(apiBase) && valid(webBase) && webAppMismatch({ apiBase: apiBase.trim(), webBase: webBase.trim() }) && (
          <Banner kind="warn">{webAppMismatch({ apiBase: apiBase.trim(), webBase: webBase.trim() })}</Banner>
        )}
        <div class="row gap-s">
          <button type="submit" class="btn btn-primary">
            Save
          </button>
          <button
            type="button"
            class="btn btn-ghost"
            onClick={() => {
              setApi(DEFAULT_SETTINGS.apiBase);
              setWeb(DEFAULT_SETTINGS.webBase);
            }}
          >
            Reset
          </button>
        </div>

        <details class="dev">
          <summary>Development</summary>
          <Field id="token" label="Paste a token" hint="For local backends with the development bypass, where any bearer works. Not for production accounts.">
            {(aria) => (
              <input {...aria} type="password" autoComplete="off" value={token} placeholder="dev-token" onInput={(e) => setToken((e.currentTarget as HTMLInputElement).value)} />
            )}
          </Field>
          <button
            type="button"
            class="btn btn-secondary"
            disabled={!token.trim()}
            onClick={() => {
              fx.acceptToken(token.trim());
              setToken('');
            }}
          >
            Use this token
          </button>
        </details>

        <div class="account">
          <p class="muted small">{state.token ? 'Signed in to Archetype.' : 'Not signed in.'}</p>
          {state.token && (
            <button type="button" class="btn btn-ghost danger" onClick={() => fx.signOut()}>
              Sign out
            </button>
          )}
        </div>
        <p class="fineprint">Archetype for Figma {state.pluginVersion}</p>
      </div>
    </form>
  );
}
