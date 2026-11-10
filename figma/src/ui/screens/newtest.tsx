import { useMemo } from 'preact/hooks';
import { importText } from '../../lib/launch';
import { BLOCKER_TEXT, isFlowBlocker, runPreflight, type Preflight } from '../../lib/preflight';
import type { AppState } from '../../lib/state';
import { RUN_SIZES, validateForm, type RunSize } from '../../lib/study';
import type { DocSnapshot, NodeRef } from '../../lib/types';
import { toMain } from '../bridge';
import type { Effects } from '../effects';
import { IconArrow, IconCheck, IconRefresh, IconStop, IconTarget, IconWarn } from '../icons';
import { Banner, Field, FrameChip, Section, plural } from '../parts';
import type { Store } from '../store';

function FramePicker(props: {
  role: 'start' | 'goal';
  value: string | null;
  doc: DocSnapshot;
  selection: NodeRef | null;
  error?: string | undefined;
  store: Store;
}) {
  const { role, value, doc, selection, store } = props;
  const label = role === 'start' ? 'Start here' : 'Goal screen';
  // Component sets stay in the snapshot (their layers' interactions are read) but are not screens.
  const screens = doc.frames.filter((f) => !f.notAScreen);
  const current = screens.find((f) => f.id === value) ?? null;
  const flowNames = new Map(doc.flowStarts.map((f) => [f.nodeId, f.name]));
  const selId = `pick-${role}`;
  const canUse = !!selection && selection.id !== value;
  return (
    <div class={`pick pick-${role}${props.error ? ' has-error' : ''}`}>
      <div class="pick-head">
        <span class="pick-label">
          {role === 'start' ? <span class="dot dot-start" aria-hidden="true" /> : <IconTarget size={12} />}
          <label for={selId}>{label}</label>
        </span>
        <span class="pick-actions">
        {current && (
          <button type="button" class="link-btn quiet" title={`Show "${current.name}" on the canvas`} onClick={() => toMain({ type: 'show-node', nodeId: current.id })}>
            Show
          </button>
        )}
        <button
          type="button"
          class="link-btn"
          disabled={!canUse}
          title={selection ? `Use "${selection.name}"` : 'Select a frame on the canvas first'}
          onClick={() => store.dispatch({ type: 'use-selection', role })}
        >
          Use selection
        </button>
        </span>
      </div>
      <select
        id={selId}
        class="pick-select"
        value={value ?? ''}
        aria-invalid={props.error ? true : undefined}
        onChange={(e) => store.dispatch({ type: 'pick', role, nodeId: (e.currentTarget as HTMLSelectElement).value || null })}
      >
        <option value="">{role === 'start' ? 'Choose a start frame' : 'Choose the goal frame'}</option>
        {screens.map((f) => (
          <option value={f.id}>{flowNames.has(f.id) ? `${f.name}  (flow: ${flowNames.get(f.id)})` : f.name}</option>
        ))}
      </select>
    </div>
  );
}

function PreflightPanel({ pf, doc }: { pf: Preflight; doc: DocSnapshot }) {
  const advice = pf.deadEnds.length + pf.broken.length + pf.genericNames.length;
  return (
    <Section
      title="Preflight"
      id="preflight"
      aside={
        <button type="button" class="icon-btn" aria-label="Check the flow again" title="Check again" onClick={() => toMain({ type: 'refresh' })}>
          <IconRefresh />
        </button>
      }
    >
      <ul class="checks" aria-live="polite">
        {pf.blocker ? (
          <li class={`check ${isFlowBlocker(pf.blocker) ? 'check-block' : 'check-todo'}`}>
            {isFlowBlocker(pf.blocker) ? <IconStop /> : <IconWarn />}
            <div>
              <strong>
                {pf.blocker === 'unreachable'
                  ? 'Goal not reachable'
                  : pf.blocker === 'goal_is_overlay'
                    ? 'Goal is an overlay'
                    : pf.blocker === 'start_not_a_screen' || pf.blocker === 'goal_not_a_screen'
                      ? 'Not a screen'
                      : 'Almost there'}
              </strong>
              <p>{BLOCKER_TEXT[pf.blocker]}</p>
            </div>
          </li>
        ) : (
          <li class="check check-ok">
            <IconCheck />
            <div>
              <strong>
                Goal reachable in {plural(pf.clicks ?? 0, 'click')}
              </strong>
              <ol class="path" aria-label="Shortest path">
                {pf.path.map((p, i) => (
                  <li>
                    {i > 0 && <IconArrow size={10} />}
                    <FrameChip id={p.id} name={p.name} />
                  </li>
                ))}
              </ol>
            </div>
          </li>
        )}
        {pf.deadEnds.length > 0 && (
          <li class="check check-warn">
            <IconWarn />
            <details>
              <summary>
                <strong>{plural(pf.deadEnds.length, 'dead end')}</strong> a persona can reach and never leave
              </summary>
              <div class="chips">
                {pf.deadEnds.map((d) => (
                  <FrameChip id={d.id} name={d.name} />
                ))}
              </div>
            </details>
          </li>
        )}
        {pf.broken.length > 0 && (
          <li class="check check-warn">
            <IconWarn />
            <details>
              <summary>
                <strong>{plural(pf.broken.length, 'hotspot')}</strong> {pf.broken.length === 1 ? 'points' : 'point'} at a frame that no longer exists
              </summary>
              <ul class="issue-list">
                {pf.broken.map((b) => (
                  <li>
                    <FrameChip id={b.hotspotId} name={b.hotspotName} /> <span class="muted">on {b.frameName}</span>
                  </li>
                ))}
              </ul>
            </details>
          </li>
        )}
        {pf.genericNames.length > 0 && (
          <li class="check check-warn">
            <IconWarn />
            <details>
              <summary>
                <strong>{plural(pf.genericNames.length, 'layer name')}</strong> say nothing about what they do
              </summary>
              <p class="muted small">Personas and screen reader users hear hotspots by their layer name, like "link Rectangle 12". Rename them after what they do.</p>
              <ul class="issue-list">
                {pf.genericNames.slice(0, 12).map((g) => (
                  <li>
                    <FrameChip id={g.id} name={g.name} />
                    <span class="muted">
                      {g.kind === 'screen' ? 'screen name' : `on ${g.frameName}`}
                      {g.suggestion ? `, maybe "${g.suggestion}"` : ''}
                    </span>
                  </li>
                ))}
                {pf.genericNames.length > 12 && <li class="muted">and {pf.genericNames.length - 12} more</li>}
              </ul>
            </details>
          </li>
        )}
        {!pf.blocker && advice === 0 && (
          <li class="check check-ok subtle">
            <IconCheck />
            <div>No dead ends, broken links or unclear layer names on the way.</div>
          </li>
        )}
        {doc.truncated && (
          <li class="check check-warn">
            <IconWarn />
            <div>This page has a very large number of interactive layers; only the first few thousand were checked.</div>
          </li>
        )}
      </ul>
    </Section>
  );
}

export function NewTest({ state, store, fx }: { state: AppState; store: Store; fx: Effects }) {
  const doc = state.doc;
  const { form } = state;
  const pf = useMemo(() => (doc ? runPreflight(doc, form.startId, form.goalId) : null), [doc, form.startId, form.goalId]);
  const errors = state.touched && pf ? validateForm(form, pf, state.fileKey) : {};

  if (!doc) return <div class="screen" />;
  if (!doc.frames.some((f) => !f.notAScreen)) {
    return (
      <div class="screen empty">
        <div class="empty-art" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <h1>No frames on "{doc.pageName}"</h1>
        <p class="muted">Open the page that holds your prototype screens, or add top level frames and connect them in Prototype mode.</p>
        <button type="button" class="btn btn-secondary" onClick={() => toMain({ type: 'refresh' })}>
          <IconRefresh /> Check again
        </button>
      </div>
    );
  }

  const set = (field: 'goal' | 'who' | 'product' | 'link') => (e: Event) =>
    store.dispatch({ type: 'field', field, value: (e.currentTarget as HTMLInputElement | HTMLTextAreaElement).value });

  return (
    <form
      class="screen newtest"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void fx.launch();
      }}
    >
      <div class="scroll">
        <div class="flow" role="group" aria-label="Flow to test">
          <FramePicker role="start" value={form.startId} doc={doc} selection={state.selection} error={errors.start} store={store} />
          <div class="flow-link" aria-hidden="true">
            <span class="flow-line" />
            <span class="flow-count">{pf?.clicks != null ? plural(pf.clicks, 'click') : ''}</span>
          </div>
          <FramePicker role="goal" value={form.goalId} doc={doc} selection={state.selection} error={errors.goal} store={store} />
          {doc.flowStarts.length === 0 && <p class="muted small">This page has no flow starting point, so pick the start yourself.</p>}
        </div>

        {pf && <PreflightPanel pf={pf} doc={doc} />}

        <Section title="The test" id="test">
          <Field id="goal" label="What is the person trying to do?" error={errors.goalText} hint="Plain words, like you would brief a participant.">
            {(aria) => (
              <textarea {...aria} rows={2} maxLength={1000} placeholder="Sign up for the Pro plan and invite a teammate" value={form.goal} onInput={set('goal')} />
            )}
          </Field>
          <Field id="who" label="Who is your user?" error={errors.who}>
            {(aria) => (
              <textarea
                {...aria}
                rows={3}
                maxLength={2000}
                placeholder="Office managers at 20 to 50 person companies who order supplies monthly and are not very technical."
                value={form.who}
                onInput={set('who')}
              />
            )}
          </Field>
          <Field id="product" label="Your product in one line" error={errors.product} hint="Optional. Helps personas make sense of the screens.">
            {(aria) => <input {...aria} type="text" maxLength={300} placeholder="Supply ordering for small offices" value={form.product} onInput={set('product')} />}
          </Field>
          <Field
            id="link"
            label="Share link of this file (optional)"
            error={errors.link}
            hint={
              <>
                Personas run here in the panel. With a link, the report opens each step in the prototype: Share, then <strong>Anyone with the link can view</strong>, then Copy link.
              </>
            }
          >
            {(aria) => (
              <input
                {...aria}
                type="url"
                inputMode="url"
                autoComplete="off"
                spellcheck={false}
                placeholder="https://www.figma.com/design/..."
                value={form.link}
                onInput={set('link')}
              />
            )}
          </Field>
          <fieldset class="sizes">
            <legend>How deep</legend>
            {(Object.keys(RUN_SIZES) as RunSize[]).map((k) => (
              <label class={`size${form.size === k ? ' is-on' : ''}`}>
                <input type="radio" name="size" value={k} checked={form.size === k} onChange={() => store.dispatch({ type: 'size', size: k })} />
                <span class="size-name">{RUN_SIZES[k].label}</span>
                <span class="size-detail">{RUN_SIZES[k].detail}</span>
              </label>
            ))}
          </fieldset>
        </Section>
      </div>
      {state.gate?.kind === 'blocked' && (
        <div class="gate">
          <Banner kind="error">
            {state.gate.reason}. <span class="muted">Figma said: {state.gate.detail}</span>
          </Banner>
        </div>
      )}
      {state.gate?.kind === 'confirm-import' && (
        <div class="gate">
          <Banner
            kind="info"
            action={
              <span class="banner-actions">
                <button type="button" class="btn btn-small btn-secondary" onClick={() => fx.cancelImport()}>
                  Cancel
                </button>
                <button type="button" class="btn btn-small btn-primary" onClick={() => void fx.confirmImport()}>
                  Add and launch
                </button>
              </span>
            }
          >
            {importText(state.gate.components)}
          </Banner>
        </div>
      )}
      <footer class="actionbar">
        {state.notice && state.notice.kind === 'error' && Object.keys(errors).length > 0 ? (
          <p class="actionbar-note error" role="alert">
            {errors.flow ?? state.notice.text}
          </p>
        ) : pf?.blocker === 'unreachable' ? (
          <p class="actionbar-note error">Connect the start to the goal to launch.</p>
        ) : pf?.blocker === 'goal_is_overlay' ? (
          <p class="actionbar-note error">Pick a goal the flow navigates to.</p>
        ) : (
          <p class="actionbar-note">{form.size === 'quick' ? 'Takes about 5 to 10 minutes' : 'Takes about 15 to 30 minutes'}</p>
        )}
        <button type="submit" class="btn btn-primary" disabled={isFlowBlocker(pf?.blocker ?? null) || state.gate?.kind === 'checking' || state.gate?.kind === 'confirm-import'}>
          {state.gate?.kind === 'checking' ? 'Checking the file' : 'Launch test'}
        </button>
      </footer>
    </form>
  );
}
