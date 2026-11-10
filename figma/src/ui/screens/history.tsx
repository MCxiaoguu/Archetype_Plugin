import type { AppState } from '../../lib/state';
import type { Effects } from '../effects';
import { ago } from '../parts';

const STATUS_WORD: Record<string, string> = {
  draft: 'Starting',
  factors_ready: 'Starting',
  archetypes_ready: 'Starting',
  running: 'Running',
  complete: 'Done',
  failed: 'Stopped',
};

export function History({ state, fx }: { state: AppState; fx: Effects }) {
  const now = Date.now();
  return (
    <div class="screen history">
      <div class="scroll">
        <h1 class="screen-title">Past tests for this file</h1>
        {state.history.length === 0 ? (
          <div class="empty small">
            <p>No tests from this file yet.</p>
            <button type="button" class="btn btn-secondary" onClick={() => fx.newTest()}>
              Set up the first one
            </button>
          </div>
        ) : (
          <ul class="history-list">
            {state.history.map((h) => (
              <li>
                <button type="button" class={`history-item${state.study?.id === h.studyId ? ' is-current' : ''}`} onClick={() => fx.openStudy(h)}>
                  <span class="history-title">{h.title}</span>
                  <span class="history-sub">
                    {h.startName} to {h.goalName}
                  </span>
                  <span class="history-meta">
                    <span class={`pill pill-${h.status}`}>{STATUS_WORD[h.status] ?? h.status}</span>
                    {h.outcome && <span>{h.outcome}</span>}
                    <span class="muted">{ago(h.launchedAt, now)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
