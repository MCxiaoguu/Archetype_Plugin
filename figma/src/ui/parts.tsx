import type { ComponentChildren, JSX } from 'preact';
import { toMain } from './bridge';
import { IconCheck, IconFrame, IconStop, IconWarn } from './icons';

export function FrameChip({ id, name, title }: { id: string; name: string; title?: string }) {
  return (
    <button type="button" class="chip" title={title ?? `Show "${name}" on the canvas`} onClick={() => toMain({ type: 'show-node', nodeId: id })}>
      <IconFrame />
      <span class="chip-text">{name}</span>
    </button>
  );
}

export function Section({ title, aside, children, id }: { title: string; aside?: ComponentChildren; children: ComponentChildren; id?: string }) {
  const hid = id ? `${id}-h` : undefined;
  return (
    <section class="section" aria-labelledby={hid}>
      <div class="section-head">
        <h2 id={hid}>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function Banner({ kind, children, action }: { kind: 'info' | 'success' | 'error' | 'warn'; children: ComponentChildren; action?: ComponentChildren }) {
  const Icon = kind === 'error' ? IconStop : kind === 'success' ? IconCheck : IconWarn;
  return (
    <div class={`banner banner-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {kind !== 'info' && <Icon />}
      <div class="banner-body">{children}</div>
      {action}
    </div>
  );
}

export function Field(props: {
  id: string;
  label: string;
  hint?: ComponentChildren;
  error?: string | undefined;
  children: (aria: { id: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string }) => JSX.Element;
}) {
  const describedBy = [props.hint ? `${props.id}-hint` : '', props.error ? `${props.id}-err` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div class={`field${props.error ? ' has-error' : ''}`}>
      <label for={props.id}>{props.label}</label>
      {props.children({ id: props.id, 'aria-invalid': props.error ? true : undefined, 'aria-describedby': describedBy })}
      {props.error ? (
        <p class="field-error" id={`${props.id}-err`}>
          {props.error}
        </p>
      ) : props.hint ? (
        <p class="field-hint" id={`${props.id}-hint`}>
          {props.hint}
        </p>
      ) : null}
    </div>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div class="skeleton" aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <div class="skeleton-line" style={{ width: `${92 - i * 17}%` }} />
      ))}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return <span class="spinner" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : 'true'} />;
}

export function plural(n: number, one: string, many?: string): string {
  return `${n} ${n === 1 ? one : many ?? `${one}s`}`;
}

export function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${String(s % 60).padStart(2, '0')} s`;
}

export function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}
