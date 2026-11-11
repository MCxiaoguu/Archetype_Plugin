/**
 * The Live screen card: the screen a persona sees right now, as the session
 * rendered it for the turn, with the element it acted on marked and a
 * pulse where it clicked; what it did and what came of it underneath. With
 * several personas, chips switch between them (Follow persona is
 * untouched); ‹ › step back through the persona's earlier screens, and
 * Live returns to the latest.
 */

import { useEffect, useMemo, useState } from 'preact/hooks';
import { actionWords, frameShown, HOLD_MS, MAX_FRAMES, outcomeWords, shownRun, type LiveFrame, type LiveScreens } from '../../lib/liveScreen';
import type { Effects } from '../effects';
import { Section } from '../parts';

/** An object URL for the screen shown, revoked when it changes. */
function useImage(frame: LiveFrame | null): string | null {
  const url = useMemo(() => (frame ? URL.createObjectURL(new Blob([frame.image as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' })) : null), [frame?.image]);
  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);
  return url;
}

export function LiveScreenCard({
  screens,
  following,
  nameOf,
  fx,
}: {
  screens: LiveScreens;
  /** The persona followed on the canvas, shown by default. */
  following: string | null;
  nameOf: (runId: string) => string;
  fx: Pick<Effects, 'pickScreen' | 'stepScreen'>;
}) {
  const runId = shownRun(screens, following);
  const [, redraw] = useState(0);
  const { frame, index, kept, holding } = frameShown(screens, runId, Date.now());
  const url = useImage(frame);
  // Once the hold on the screen just acted on is over, the card moves on to the next.
  useEffect(() => {
    if (!holding) return;
    const t = setTimeout(() => redraw((n) => n + 1), HOLD_MS);
    return () => clearTimeout(t);
  }, [holding, frame?.turn, runId]);
  if (!runId || !frame || !url) return null;

  const runs = [...new Set(screens.frames.map((f) => f.runId))];
  const live = index === kept - 1 || holding;
  const doing = actionWords(frame);
  const came = outcomeWords(frame);
  // While the persona thinks on this screen, what it did on the one before brought it here.
  const before = doing === null && index > 0 ? frameShown({ ...screens, back: kept - index, viewing: runId }, runId).frame : null;
  const { width, height } = frame.viewport;
  const box = frame.target?.box;
  const clicked = frame.action?.type === 'click' || frame.action?.type === 'type';

  return (
    <Section title="Live screen" id="live" aside={<span class="muted small">{live ? 'Live' : `Step ${frame.turn} of ${kept} kept`}</span>}>
      {runs.length > 1 && (
        <ul class="ls-chips" aria-label="Whose screen">
          {runs.map((id) => (
            <li>
              <button type="button" class={`fm-persona${id === runId ? ' following' : ''}`} aria-pressed={id === runId} onClick={() => fx.pickScreen(id)}>
                {nameOf(id)}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div class="ls-view">
        <div class="ls-frame">
          <img src={url} width={width} height={height} alt={`${nameOf(runId)} on ${frame.screenName}, step ${frame.turn}`} />
          <svg class="ls-marks" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
            {box && <rect class="ls-target" x={box[0]} y={box[1]} width={box[2]} height={box[3]} rx={4} />}
            {box && clicked && frame.target && (
              <circle class="ls-pulse" key={`${runId}:${frame.turn}`} cx={frame.target.point.x} cy={frame.target.point.y} r={18} />
            )}
          </svg>
        </div>
      </div>
      <div class="ls-caption" aria-live={live ? 'polite' : 'off'}>
        <p>
          <strong>{nameOf(runId)}</strong> <span class="muted">· Step {frame.turn} · {frame.screenName}</span>
        </p>
        <p>{doing ?? 'Thinking…'}</p>
        {came && <p class="muted">{came}</p>}
        {before && actionWords(before) && (
          <p class="muted small">
            Before this: {actionWords(before)}
            {outcomeWords(before) ? ` · ${outcomeWords(before)}` : ''}
          </p>
        )}
      </div>
      <div class="ls-nav">
        <button type="button" class="btn btn-small btn-ghost" disabled={index === 0} aria-label="An earlier step" onClick={() => fx.stepScreen(runId, 1)}>
          ‹
        </button>
        <button type="button" class="btn btn-small btn-ghost" disabled={live} aria-label="A later step" onClick={() => fx.stepScreen(runId, -1)}>
          ›
        </button>
        <button type="button" class="btn btn-small btn-secondary" disabled={live} onClick={() => fx.stepScreen(runId, 'live')}>
          Live
        </button>
        {index === 0 && screens.dropped.includes(runId) && (
          <span class="muted small">Earlier steps aren't kept (the panel keeps the last {MAX_FRAMES} screens).</span>
        )}
      </div>
    </Section>
  );
}
