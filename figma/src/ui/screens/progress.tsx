import { indexFrames } from '../../lib/frames';
import { runnerState } from '../../lib/poll';
import { panelNotices, panelRunText, personaRows, runningTexts, type PersonaRow } from '../../lib/runs';
import type { AppState, Stage } from '../../lib/state';
import type { Effects } from '../effects';
import { NOTICE } from '../trace/session';
import { IconCheck, IconClock, IconExternal } from '../icons';
import { Banner, Section, Spinner, elapsed, plural } from '../parts';
import { FlowMapCard, walkersOf } from './flowmap';
import { LiveScreenCard } from './livescreen';
import { useTicker } from '../store';

function stepIndex(stage: Stage): number {
  if (stage === 'creating' || stage === 'factors') return 0;
  if (stage === 'archetypes') return 1;
  return 2;
}

const PHASE_LABEL: Record<PersonaRow['phase'], string> = { waiting: 'Waiting', running: 'Running', done: 'Done' };

function PersonaList({ rows }: { rows: PersonaRow[] }) {
  return (
    <ul class="personas" aria-label="Personas">
      {rows.map((r) => (
        <li class={`persona phase-${r.phase}`}>
          <span class={`status-dot ${r.phase === 'done' ? (r.completed === r.runs ? 'ok' : r.completed === 0 ? 'bad' : 'mixed') : r.phase}`} aria-hidden="true" />
          <div class="persona-main">
            <span class="persona-name">{r.name}</span>
            <span class="persona-sub">
              <span class="sr-only">{PHASE_LABEL[r.phase]}. </span>
              {r.statusText}
            </span>
          </div>
          <span class="persona-meta">{r.steps != null ? plural(r.steps, 'step') : r.runs > 1 ? `${r.runs} tries` : ''}</span>
        </li>
      ))}
    </ul>
  );
}

export function Progress({ state, fx }: { state: AppState; fx: Effects }) {
  const st = state.study;
  const now = useTicker(!!st && st.stage !== 'done');
  if (!st) return <div class="screen" />;
  const idx = stepIndex(st.stage);
  // The study's own size once its record exists; before that, the size the form launched with.
  const texts = runningTexts(st.record?.size ?? state.form.size);
  // A plugin-mode study runs its personas in this panel; the screen and step come from its sessions.
  const inPanel = !!st.record?.trace;
  const rows = personaRows(st.runs, indexFrames(state.doc), { live: st.live, inPanel });
  const runner = runnerState(st.runs, st.queuedSince, now);
  const notices = inPanel ? panelNotices(st.live, st.runner) : [];
  // The sessions already say they lost touch: the poll's banner would say it twice.
  const pollError = st.pollError && !notices.includes(NOTICE.offline) ? st.pollError : null;
  const total = st.runs.length;
  const finished = rows.reduce((s, r) => s + r.finished, 0);
  const title = st.record?.title ?? 'New test';

  let runText = '';
  if (inPanel) runText = panelRunText(rows, st.runner, runner);
  else if (runner === 'running') runText = 'Personas are clicking through your prototype.';
  else if (runner === 'queued') runText = 'Queued. A runner picks the tests up shortly.';
  else if (runner === 'finishing') runText = 'All tries are in. Putting the results together.';

  return (
    <div class="screen progress">
      <div class="scroll">
        <header class="study-head">
          <p class="eyebrow">{st.record ? `${st.record.startName} to ${st.record.goalName}` : 'Launching'}</p>
          <h1 class="study-title">{title}</h1>
        </header>

        {st.error && (
          <Banner
            kind="error"
            action={
              <button type="button" class="btn btn-small btn-secondary" onClick={() => void fx.retry()}>
                Try again
              </button>
            }
          >
            {st.error}
          </Banner>
        )}

        {inPanel && st.screens.frames.length > 0 && (
          <LiveScreenCard screens={st.screens} following={st.flow.following} nameOf={(id) => st.runs.find((r) => r.runId === id)?.archetypeName || id} fx={fx} />
        )}

        <ol class="stages" aria-label="Progress">
          {texts.steps.map((s, i) => {
            const state_ = i < idx || st.stage === 'done' ? 'done' : i === idx ? (st.error ? 'failed' : 'active') : 'todo';
            return (
              <li class={`stage stage-${state_}`} aria-current={state_ === 'active' ? 'step' : undefined}>
                <span class="stage-mark" aria-hidden="true">
                  {state_ === 'done' ? <IconCheck size={11} /> : state_ === 'active' ? <Spinner /> : i + 1}
                </span>
                <div class="stage-body">
                  <span class="stage-title">
                    {s.title}
                    {state_ === 'active' && i < 2 && <span class="stage-time">{elapsed(now - st.stageStartedAt)}</span>}
                  </span>
                  {state_ === 'active' && <span class="stage-hint">{i === 2 && total > 0 ? `${finished} of ${plural(total, 'try', 'tries')} finished` : s.hint}</span>}
                </div>
              </li>
            );
          })}
        </ol>

        {idx === 2 && (
          <Section title={texts.section} id="personas">
            {runner === 'waiting_for_runner' && !inPanel && (
              <Banner kind="warn">
                <strong>Waiting for a runner.</strong> The tests are queued, but no runner has picked them up yet. They start as soon as one is online; you can close this panel and come back.
              </Banner>
            )}
            {pollError && <Banner kind="info">Lost touch with Archetype ({pollError}). Still trying.</Banner>}
            {st.runner?.phase === 'other_page' && (
              <Banner
                kind="warn"
                action={
                  <button type="button" class="btn btn-small btn-secondary" onClick={() => fx.goToTestPage()}>
                    Go to page
                  </button>
                }
              >
                {st.runner.notice}
              </Banner>
            )}
            {st.runner?.phase === 'progress_unreadable' && (
              <Banner
                kind="error"
                action={
                  <button type="button" class="btn btn-small btn-secondary" onClick={() => void fx.forgetProgress()}>
                    Forget saved progress for this test
                  </button>
                }
              >
                {st.runner.notice} Forgetting it lets each try start over where Archetype has nothing yet; tries that had already started are ended.
              </Banner>
            )}
            {st.runner?.phase === 'map_failed' && (
              <Banner
                kind="error"
                action={
                  <span class="banner-actions">
                    <button type="button" class="btn btn-small btn-secondary" onClick={() => fx.retryMap(false)}>
                      Try again
                    </button>
                    <button type="button" class="btn btn-small btn-ghost" onClick={() => fx.retryMap(true)}>
                      Launch with drawn connections only
                    </button>
                  </span>
                }
              >
                {st.runner.notice}
              </Banner>
            )}
            {notices.map((n) => (
              <Banner key={n} kind="warn">
                {n}
              </Banner>
            ))}
            {rows.length === 0 ? (
              <div class="placeholder" role="status">
                <Spinner /> Setting up the tries
              </div>
            ) : (
              <>
                <PersonaList rows={rows} />
                {runText && (
                  <p class="muted small live" role="status" aria-live="polite">
                    {runText}
                  </p>
                )}
              </>
            )}
          </Section>
        )}
        {inPanel && st.record?.trace && (st.flow.map || st.flow.error) && (
          <FlowMapCard
            flow={st.flow}
            start={st.record.trace.startFrameId}
            walkers={walkersOf(st.runs, st.live)}
            live
            goal={null}
            fx={fx}
            fold={{ open: state.prefs.flowMapOpen, toggle: (open) => fx.setFlowMapOpen(open) }}
          />
        )}
        {st.stage === 'done' && !st.report && !st.reportError && (
          <div class="placeholder" role="status">
            <Spinner /> Loading the report
          </div>
        )}
        {st.reportError && (
          <Banner
            kind="error"
            action={
              <button type="button" class="btn btn-small btn-secondary" onClick={() => void fx.retry()}>
                Try again
              </button>
            }
          >
            The report did not load: {st.reportError}
          </Banner>
        )}
      </div>
      <footer class="actionbar">
        <p class="actionbar-note">
          <IconClock size={12} /> {inPanel && st.stage !== 'done' ? texts.keepOpen : st.stage === 'watching' ? 'Updates every few seconds' : 'Keep this panel open for now'}
        </p>
        {st.id && (
          <button type="button" class="btn btn-secondary" onClick={() => fx.openInArchetype()}>
            Open in Archetype <IconExternal />
          </button>
        )}
      </footer>
    </div>
  );
}
