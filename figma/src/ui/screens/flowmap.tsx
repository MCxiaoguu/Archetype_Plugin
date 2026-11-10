/**
 * The Flow map card (spec, The Flow map in the panel): the study's map as a
 * graph, left to right from the start node. Drawn edges are solid, inferred
 * ones dashed, gaps short stubs ending in a dot; a node a persona saw shows
 * that screen. On the Running screen each persona is a token that moves
 * along its path, and clicking one follows it on the canvas; on the Report
 * screen (and a past study's) the paths come from the stored steps. Clear
 * paths hides them until the panel opens the study again.
 */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { edgeKey, gapsHitIn, gapsShown, graphOf, layoutFlow, liveMarks, NODE_HEIGHT, NODE_WIDTH, pastMarks, type Marks, type Walker } from '../../lib/flowLayout';
import type { FlowMap, FlowReading, ReadingKind } from '../../lib/proto/flow';
import type { LiveRun } from '../../lib/runs';
import type { FlowCard } from '../../lib/state';
import type { Effects } from '../effects';
import { Banner, Section } from '../parts';

/** Each persona's colour, by its place in the study's list. */
const TOKEN_COLORS = ['#0d99ff', '#14ae5c', '#f24822', '#9747ff', '#ffa629', '#0fa8b0'];
const PAD = 12;
const TOKEN = 4;
/** The most characters of a node's name that fit its box. */
const NAME_CHARS = 13;
const LABEL_BAND = 13;

const short = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const colorOf = (slot: number) => TOKEN_COLORS[slot % TOKEN_COLORS.length] as string;

/** Object URLs for the screens the personas saw, revoked when they change. */
function useShots(shots: Record<string, Uint8Array>): Record<string, string> {
  const urls = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [node, image] of Object.entries(shots)) out[node] = URL.createObjectURL(new Blob([image as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }));
    return out;
  }, [shots]);
  useEffect(() => () => Object.values(urls).forEach((u) => URL.revokeObjectURL(u)), [urls]);
  return urls;
}

/** A reading as the editor's select holds it: gap, control, or `edge:<frame>`. */
const choiceOf = (r: FlowReading) => (r.kind === 'edge' ? `edge:${r.to as string}` : r.kind);

/**
 * Edit map (spec, Editing): every reading, frame by frame (on the first
 * frame it appears on), set to a link to a chosen frame, a control or a
 * gap. One edit writes the next version, which runs claimed after it play.
 */
function MapEditor({ map, order, fx }: { map: FlowMap; order: string[]; fx: Pick<Effects, 'editReading'> }) {
  const [saving, setSaving] = useState<string | null>(null);
  const frames = map.nodes.filter((n) => n.kind === 'frame');
  const nameOf = new Map(map.nodes.map((n) => [n.id, n.name]));
  const byNode = new Map<string, FlowReading[]>();
  for (const r of map.readings) {
    const first = r.nodes[0] as string;
    byNode.set(first, [...(byNode.get(first) ?? []), r]);
  }
  const set = async (r: FlowReading, choice: string) => {
    const [kind, to] = choice.startsWith('edge:') ? ['edge', choice.slice(5)] : [choice, null];
    setSaving(r.id);
    try {
      await fx.editReading(r.id, kind as ReadingKind, to);
    } finally {
      setSaving(null);
    }
  };
  if (map.readings.length === 0) return <p class="muted small">This map has no readings: every element of the prototype is wired.</p>;
  return (
    <div class="fm-editor">
      <p class="muted small">Version {map.version}. Runs that start after an edit play the new version; runs under way keep theirs.</p>
      {order
        .filter((id) => byNode.has(id))
        .map((id) => (
          <div class="fm-edit-node">
            <p class="fm-edit-frame">{nameOf.get(id)}</p>
            <ul class="fm-edit-list">
              {(byNode.get(id) as FlowReading[]).map((r) => {
                const more = new Set(r.nodes).size - 1;
                return (
                  <li class="fm-edit-row">
                    <span class="fm-edit-label" title={r.reason}>
                      {r.label || r.role}
                      {more > 0 && <span class="muted small"> (and {more} more {more === 1 ? 'screen' : 'screens'})</span>}
                      {r.by === 'designer' && <span class="muted small"> · yours</span>}
                    </span>
                    <select
                      aria-label={`What "${r.label || r.role}" does`}
                      value={choiceOf(r)}
                      disabled={saving !== null}
                      onChange={(e) => void set(r, (e.target as HTMLSelectElement).value)}
                    >
                      <option value="gap">No page yet</option>
                      <option value="control">A control</option>
                      {frames.map((f) => (
                        <option value={`edge:${f.id}`}>{f.id === id ? 'Stays on this screen' : `Opens ${f.name}`}</option>
                      ))}
                    </select>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
    </div>
  );
}

/** The personas of a study walking its map in this panel, in the study's order, from their sessions. */
export function walkersOf(runs: ReadonlyArray<{ runId: string; archetypeName: string }>, live: Readonly<Record<string, LiveRun>>): Walker[] {
  return runs
    .filter((r) => live[r.runId])
    .map((r) => {
      const s = live[r.runId] as LiveRun;
      const ended = s.ended ? (s.ended.status === 'completed' || s.ended.reason === 'done' ? 'reached' : 'stopped') : null;
      return { id: r.runId, name: r.archetypeName || r.runId, node: s.node, move: s.move, ended };
    });
}

export function FlowMapCard({
  flow,
  start,
  walkers,
  live,
  goal,
  fx,
}: {
  flow: FlowCard;
  /** The node the layout starts from: the test's start frame. */
  start: string;
  /** The personas walking the map now (Running), in the study's order. */
  walkers: Walker[];
  /** Running: tokens follow the live sessions; otherwise the stored paths. */
  live: boolean;
  goal: string | null;
  fx: Pick<Effects, 'followPersona' | 'clearPaths' | 'editReading'>;
}) {
  const [editing, setEditing] = useState(false);
  const shots = useShots(flow.shots);
  const scroller = useRef<HTMLDivElement>(null);
  const map = flow.map;
  // Only the gaps a persona clicked in the paths shown get a stub; the rest are a count per node.
  const hit = useMemo(() => (flow.cleared ? new Set<string>() : live ? new Set(flow.gapsHit) : gapsHitIn(flow.paths ?? [])), [flow.cleared, flow.gapsHit, flow.paths, live]);
  const graph = useMemo(() => {
    if (!map) return null;
    const g = graphOf(map);
    const { shown, hidden } = gapsShown(g.gaps, hit);
    return { layout: layoutFlow(g.nodes, g.edges, shown, start), hidden };
  }, [map, start, hit]);
  const layout = graph?.layout ?? null;

  // The node to keep in view: the followed persona's, else where the latest move went.
  const latest = [...walkers].filter((w) => w.move).sort((a, b) => (b.move?.turn ?? 0) - (a.move?.turn ?? 0))[0];
  const focus = flow.cleared || !live ? null : (walkers.find((w) => w.id === flow.following)?.node ?? latest?.move?.to ?? null);
  const focusX = focus && layout ? layout.nodes.find((n) => n.id === focus)?.x ?? null : null;
  useEffect(() => {
    const el = scroller.current;
    if (!el || focusX === null) return;
    const left = focusX + PAD;
    if (left < el.scrollLeft || left + NODE_WIDTH > el.scrollLeft + el.clientWidth) el.scrollTo({ left: Math.max(0, left - PAD * 2), behavior: 'smooth' });
  }, [focusX]);

  if (flow.error && !map) {
    return (
      <Section title="Flow map" id="flowmap">
        <Banner kind="error">{flow.error}</Banner>
      </Section>
    );
  }
  if (!map || !layout) return null;

  const marks: Marks = flow.cleared ? liveMarks([]) : live ? liveMarks(walkers) : pastMarks(flow.paths ?? [], goal);
  const at = new Map(layout.nodes.map((n) => [n.id, n]));
  const nameOf = (id: string) => (at.get(id) as { name: string }).name;
  const tokensOn = new Map<string, Marks['tokens']>();
  for (const t of marks.tokens) tokensOn.set(t.node, [...(tokensOn.get(t.node) ?? []), t]);
  const following = flow.following ? marks.tokens.find((t) => t.id === flow.following) : undefined;
  const anything = marks.tokens.length > 0 || marks.lit.size > 0;

  return (
    <Section
      title="Flow map"
      id="flowmap"
      aside={
        <span class="row gap-s">
          {anything && (
            <button type="button" class="link-btn quiet" onClick={() => fx.clearPaths()}>
              Clear paths
            </button>
          )}
          <button type="button" class="link-btn quiet" aria-expanded={editing} onClick={() => setEditing(!editing)}>
            {editing ? 'Done editing' : 'Edit map'}
          </button>
        </span>
      }
    >
      {editing && <MapEditor map={map} order={layout.nodes.map((n) => n.id)} fx={fx} />}
      <div class="fm-scroll" ref={scroller}>
        <svg
          class="fm"
          width={layout.width + PAD * 2}
          height={layout.height + PAD * 2}
          viewBox={`${-PAD} ${-PAD} ${layout.width + PAD * 2} ${layout.height + PAD * 2}`}
          role="img"
          aria-label={`Flow map version ${map.version}: ${layout.nodes.length} screens`}
        >
          {layout.edges.map((e) => (
            <path class={`fm-edge${e.inferred ? ' inferred' : ''}${marks.lit.has(edgeKey(e.from, e.to)) ? ' lit' : ''}`} d={e.path}>
              <title>{`${nameOf(e.from)} to ${nameOf(e.to)}${e.inferred ? ', read from the screens' : ''}`}</title>
            </path>
          ))}
          {layout.gaps.map((g) => (
            <g class="fm-gap">
              <title>{`No page behind "${g.label}" yet`}</title>
              <line x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} />
              <circle cx={g.x2} cy={g.y2} r={2} />
            </g>
          ))}
          {layout.nodes.map((n) => {
            const move = marks.moves.find((m) => m.from === n.id || m.to === n.id);
            const pulse = marks.pulses.find((p) => p.node === n.id);
            const end = marks.ends.find((e) => e.node === n.id);
            const cls = ['fm-node', n.kind, n.reached ? '' : 'unreached', move ? (move.to === n.id ? 'now' : 'was') : '', pulse ? 'pulse' : ''].filter(Boolean).join(' ');
            return (
              <g class={cls} transform={`translate(${n.x} ${n.y})`} key={`${n.id}:${move?.key ?? ''}:${pulse?.key ?? ''}`}>
                <title>{n.name}</title>
                <rect class="fm-box" width={NODE_WIDTH} height={NODE_HEIGHT} rx={4} />
                {shots[n.id] ? (
                  <>
                    <image href={shots[n.id]} x={1} y={1} width={NODE_WIDTH - 2} height={NODE_HEIGHT - LABEL_BAND - 1} preserveAspectRatio="xMidYMin slice" />
                    <rect class="fm-band" x={1} y={NODE_HEIGHT - LABEL_BAND} width={NODE_WIDTH - 2} height={LABEL_BAND - 1} />
                  </>
                ) : null}
                <text class="fm-name" x={NODE_WIDTH / 2} y={shots[n.id] ? NODE_HEIGHT - 3 : NODE_HEIGHT / 2 + 4} text-anchor="middle">
                  {short(n.name, NAME_CHARS)}
                </text>
                {(() => {
                  const without = (graph?.hidden.get(n.id) ?? 0) + n.moreGaps;
                  const drawn = layout.gaps.some((g) => g.node === n.id);
                  return without > 0 ? (
                    <text class="fm-more" x={0} y={NODE_HEIGHT + 9}>
                      {without} {drawn ? 'more ' : ''}without a page
                    </text>
                  ) : null;
                })()}
                {(tokensOn.get(n.id) ?? []).map((t, i) => (
                  <circle class="fm-token" cx={7 + i * (TOKEN * 2 + 2)} cy={7} r={TOKEN} fill={colorOf(t.slot)}>
                    <title>{t.name}</title>
                  </circle>
                ))}
                {end && (
                  <text class={`fm-end ${end.reached ? 'ok' : 'bad'}`} x={NODE_WIDTH - 8} y={12} text-anchor="middle">
                    {end.reached ? '✓' : '✕'}
                  </text>
                )}
                {pulse?.label && (
                  <text class="fm-pulse-label" x={0} y={-3}>
                    No page: {short(pulse.label, 18)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      {marks.tokens.length > 0 && (
        <ul class="fm-legend" aria-label="Personas on the map">
          {marks.tokens.map((t) => (
            <li>
              {live ? (
                <button
                  type="button"
                  class={`fm-persona${flow.following === t.id ? ' following' : ''}`}
                  aria-pressed={flow.following === t.id}
                  title={flow.following === t.id ? 'Stop following' : `Follow ${t.name} on the canvas`}
                  onClick={() => fx.followPersona(flow.following === t.id ? null : t.id)}
                >
                  <span class="fm-dot" style={{ background: colorOf(t.slot) }} />
                  {t.name}
                </button>
              ) : (
                <span class="fm-persona">
                  <span class="fm-dot" style={{ background: colorOf(t.slot) }} />
                  {t.name}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {following && (
        <p class="muted small" role="status">
          Following {following.name}
          {flow.followNote ? `. ${flow.followNote}.` : ' on the canvas.'}
        </p>
      )}
      {flow.error && (
        <p class="muted small" role="alert">
          {flow.error}
        </p>
      )}
    </Section>
  );
}
