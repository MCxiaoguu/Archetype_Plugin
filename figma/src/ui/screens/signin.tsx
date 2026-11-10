import type { AppState } from '../../lib/state';
import type { Effects } from '../effects';
import { toMain } from '../bridge';
import { Banner, Spinner } from '../parts';
import { IconExternal, Mark } from '../icons';

export function SignIn({ state, fx }: { state: AppState; fx: Effects }) {
  const { auth } = state;
  if (auth.phase === 'waiting' && auth.code) {
    const code = auth.code;
    return (
      <div class="screen signin">
        <div class="signin-code-card">
          <p class="eyebrow">Confirm in your browser</p>
          <p class="user-code" aria-label={`Your code is ${code.user_code.split('').join(' ')}`}>
            {code.user_code}
          </p>
          <p class="muted">We opened Archetype in your browser. Check that it shows this code, then approve. This panel continues on its own.</p>
          <div class="waiting-row" role="status" aria-live="polite">
            <Spinner /> Waiting for approval
          </div>
          <div class="row gap">
            <button type="button" class="btn btn-secondary" onClick={() => toMain({ type: 'open-url', url: code.verification_uri_complete || code.verification_uri })}>
              Open the page again <IconExternal />
            </button>
            <button type="button" class="btn btn-ghost" onClick={() => fx.cancelSignIn()}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div class="screen signin">
      <div class="hero">
        <div class="hero-mark">
          <Mark size={28} />
        </div>
        <h1>Test this flow with synthetic users</h1>
        <p class="lede">Pick a start and a goal screen, say who your user is, and watch personas click through your prototype before handoff.</p>
        <ol class="steps-list">
          <li>
            <span class="step-n">1</span>Choose where the flow starts and the screen that means done.
          </li>
          <li>
            <span class="step-n">2</span>Describe your user in your own words.
          </li>
          <li>
            <span class="step-n">3</span>See who got through, where they gave up, and why.
          </li>
        </ol>
      </div>
      {state.notice && <Banner kind={state.notice.kind}>{state.notice.text}</Banner>}
      {auth.phase === 'error' && auth.error && <Banner kind="error">{auth.error}</Banner>}
      <div class="signin-actions">
        <button type="button" class="btn btn-primary btn-wide" disabled={auth.phase === 'starting'} onClick={() => void fx.signIn()}>
          {auth.phase === 'starting' ? (
            <>
              <Spinner /> Opening your browser
            </>
          ) : (
            'Sign in with Archetype'
          )}
        </button>
        <p class="fineprint">
          Free to install. Tests run on your Archetype account. What you type, the file and page names and the screen names on the path leave this file, and during a test every step sends a screenshot, its visible
          text and what can be clicked to Archetype and its AI model provider.
        </p>
      </div>
    </div>
  );
}
