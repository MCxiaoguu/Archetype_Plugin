import { indexFrames } from '../../lib/frames';
import { runnerState } from '../../lib/poll';
import { personaRows, type PersonaRow } from '../../lib/runs';
import type { AppState, Stage } from '../../lib/state';
import type { Effects } from '../effects';
import { IconCheck, IconClock, IconExternal } from '../icons';
import { Banner, Section, Spinner, elapsed, plural } from '../parts';
import { useTicker } from '../store';

type Step = { key: 'understand' | 'personas' | 'run'; title: string; hint: string };

const STEPS: Step[] = [
  { key: 'understand', title: 'Understanding your users', hint: 'Finding the traits most likely to change whether someone finishes. Usually under 30 s.' },
  { key: 'personas', title: 'Building personas', hint: 'One typical user, then variants that each differ in one trait. Usually about a minute.' },
  { key: 'run', title: 'Running', hint: 'Personas open your prototype and click through it.' },
];

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
  const rows = personaRows(st.runs, st.latest, indexFrames(state.doc));
  const runner = runnerState(st.runs, st.queuedSince, now);
  const total = st.runs.length;
  const finished = rows.reduce((s, r) => s + r.finished, 0);
  const title = st.record?.title ?? 'New test';

  let runText = '';
  if (runner === 'running') runText = 'Personas are clicking through your prototype.';
  else if (runner === 'queued') runText = 'Queued. A runner picks the tests up shortly.';
  else if (runner === 'waiting_for_runner') runText = '';
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

        <ol class="stages" aria-label="Progress">
          {STEPS.map((s, i) => {
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
          <Section title="Personas" id="personas">
            {runner === 'waiting_for_runner' && (
              <Banner kind="warn">
                <strong>Waiting for a runner.</strong> The tests are queued, but no runner has picked them up yet. They start as soon as one is online; you can close this panel and come back.
              </Banner>
            )}
            {st.pollError && <Banner kind="info">Lost touch with Archetype ({st.pollError}). Still trying.</Banner>}
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
          <IconClock size={12} /> {st.stage === 'watching' ? 'Checking every few seconds while this panel is open' : 'Keep this panel open until the runs start'}
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
