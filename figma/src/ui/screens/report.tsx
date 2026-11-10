import { useMemo } from 'preact/hooks';
import { indexFrames } from '../../lib/frames';
import { buildReportView } from '../../lib/report';
import type { AppState } from '../../lib/state';
import { toMain } from '../bridge';
import type { Effects } from '../effects';
import { IconExternal, IconPin } from '../icons';
import { Banner, FrameChip, Section, Skeleton, plural } from '../parts';

const SEVERITY_CLASS: Record<number, string> = { 0: 'sev-0', 1: 'sev-1', 2: 'sev-2', 3: 'sev-3', 4: 'sev-4' };

export function Report({ state, fx }: { state: AppState; fx: Effects }) {
  const st = state.study;
  const report = st?.report ?? null;
  const view = useMemo(() => (report ? buildReportView(report, indexFrames(state.doc)) : null), [report, state.doc]);
  if (!st) return <div class="screen" />;
  if (!view) {
    return (
      <div class="screen">
        <div class="scroll">
          {st.reportError ? (
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
          ) : (
            <Skeleton lines={6} />
          )}
        </div>
      </div>
    );
  }
  const k = view.personas.reduce((s, p) => s + p.k, 0);
  const n = view.personas.reduce((s, p) => s + p.n, 0);
  const maxDrop = Math.max(1, ...view.dropOff.map((d) => d.count));

  return (
    <div class="screen report">
      <div class="scroll">
        <header class="study-head">
          <p class="eyebrow">{st.record ? `${st.record.startName} to ${st.record.goalName}` : 'Report'}</p>
          <h1 class="study-title">{report?.title}</h1>
        </header>
        {view.partial && <Banner kind="info">Some tries are still running; this report covers {plural(view.runsScored, 'finished try', 'finished tries')}.</Banner>}

        <div class="score" role="group" aria-label={`${k} of ${n} tries reached the goal`}>
          <div class="score-num">
            <span class="score-k">{k}</span>
            <span class="score-n">of {n}</span>
          </div>
          <div class="score-side">
            <span class="score-label">tries reached the goal</span>
            <div class="score-bar" aria-hidden="true">
              {view.personas.flatMap((p) =>
                Array.from({ length: p.n }, (_, i) => <span class={i < p.k ? 'seg seg-ok' : 'seg seg-no'} title={p.name} />),
              )}
            </div>
          </div>
        </div>
        <p class="headline">{view.headline}</p>

        <Section title="Who got through" id="who">
          <ul class="results">
            {view.personas.map((p) => (
              <li class="result">
                <div class="result-top">
                  <span class="result-name">{p.name}</span>
                  <span class={`result-k ${p.n === 0 ? '' : p.k === p.n ? 'ok' : p.k === 0 ? 'bad' : 'mixed'}`}>
                    {p.n === 0 ? 'no tries' : `${p.k} of ${p.n}`}
                  </span>
                </div>
                <div class="result-meta">
                  <span class="role">{p.roleLabel}</span>
                  {p.confidenceWords && <span class={`confidence conf-${p.confidence ?? 'none'}`}>{p.confidenceWords}</span>}
                  {p.gaveUpBecause && <span class="muted">gave up: {p.gaveUpBecause}</span>}
                </div>
                {p.quote && <blockquote class="quote">{p.quote}</blockquote>}
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Top findings" id="findings">
          {view.findings.length === 0 ? (
            <p class="muted">No problems came up in {plural(view.runsScored, 'try', 'tries')}.</p>
          ) : (
            <ul class="findings">
              {view.findings.map((f) => (
                <li class="finding">
                  <div class="finding-top">
                    <span class={`sev ${SEVERITY_CLASS[f.severity] ?? 'sev-2'}`}>{f.severityLabel}</span>
                    <span class="finding-id">{f.id}</span>
                  </div>
                  <p class="finding-title">{f.title}</p>
                  <p class="muted small">
                    {plural(f.hitBy.length, 'persona')}, {f.hitCount} of {plural(f.runCount, 'try', 'tries')}
                  </p>
                  {f.frames.length > 0 ? (
                    <div class="chips">
                      {f.frames.map((fr) => (
                        <FrameChip id={fr.id} name={fr.name} />
                      ))}
                    </div>
                  ) : (
                    <p class="muted small">Happened on a screen that is not on this page.</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Where they gave up" id="dropoff">
          {view.dropOff.length === 0 ? (
            <p class="muted">Nobody gave up.</p>
          ) : (
            <ul class="drops">
              {view.dropOff.map((d) => (
                <li class="drop">
                  <div class="drop-label">
                    {d.frame ? (
                      <button type="button" class="drop-name" onClick={() => toMain({ type: 'show-node', nodeId: d.frame!.id })}>
                        {d.label}
                      </button>
                    ) : (
                      <span class="drop-name muted">{d.label}</span>
                    )}
                    <span class="drop-count">{d.count}</span>
                  </div>
                  <div class="drop-bar" aria-hidden="true">
                    <span style={{ width: `${(d.count / maxDrop) * 100}%` }} />
                  </div>
                  <p class="muted small">{d.personas.join(', ')}</p>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {view.changes.length > 0 && (
          <Section title="What to change first" id="changes">
            <ol class="changes">
              {view.changes.map((c) => (
                <li>
                  <strong>{c.title}</strong>
                  <p class="muted">{c.whatToChange}</p>
                </li>
              ))}
            </ol>
          </Section>
        )}
        {view.caveat && <p class="caveat">{view.caveat}</p>}
      </div>
      <footer class="actionbar actionbar-split">
        <div class="row gap-s">
          <button type="button" class="btn btn-secondary" onClick={() => fx.pin()} title="Add one annotation per affected frame">
            <IconPin size={12} /> Pin findings
          </button>
          <button type="button" class="btn btn-ghost" onClick={() => toMain({ type: 'clear-pins' })}>
            Clear pins
          </button>
        </div>
        <button type="button" class="btn btn-primary" onClick={() => fx.openInArchetype()}>
          Open in Archetype <IconExternal />
        </button>
      </footer>
    </div>
  );
}
