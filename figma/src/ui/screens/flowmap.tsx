/**
 * The Flow map card (spec, The Flow map in the panel): the study's map as a
 * graph, left to right from the start node. Drawn edges are solid, inferred
 * ones dashed, gaps short stubs ending in a dot; a node a persona saw shows
 * that screen. On the Running screen each persona is a token that moves
 * along its path, and clicking one follows it on the canvas; on the Report
 * screen (and a past study's) the paths come from the stored steps. Clear
 * paths hides them until the panel opens the study again.
 */

import { useEffect, useMemo } from 'preact/hooks';
import { edgeKey, graphOf, layoutFlow, liveMarks, NODE_HEIGHT, NODE_WIDTH, pastMarks, type Marks, type Walker } from '../../lib/flowLayout';
import type { LiveRun } from '../../lib/runs';
import type { FlowCard } from '../../lib/state';
import type { Effects } from '../effects';
import { Banner, Section } from '../parts';

/** Each persona's colour, by its place in the study's list. */
const TOKEN_COLORS = ['#0d99ff', '#14ae5c', '#f24822', '#9747ff', '#ffa629', '#0fa8b0'];
const PAD = 12;
const TOKEN = 5;
/** The most characters of a node's name that fit its box. */
const NAME_CHARS = 15;

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
  fx: Pick<Effects, 'followPersona' | 'clearPaths'>;
}) {
  const shots = useShots(flow.shots);
  const map = flow.map;
  const layout = useMemo(() => {
    if (!map) return null;
    const g = graphOf(map);
    return layoutFlow(g.nodes, g.edges, g.gaps, start);
  }, [map, start]);

  if (flow.error && !map) {
    return (
      <Section title="Flow map" id="flowmap">
        <Banner kind="error">The flow map did not load: {flow.error}</Banner>
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
        anything && (
          <button type="button" class="link-btn quiet" onClick={() => fx.clearPaths()}>
            Clear paths
          </button>
        )
      }
    >
      <div class="fm-scroll">
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
                  <image href={shots[n.id]} x={1} y={1} width={NODE_WIDTH - 2} height={NODE_HEIGHT - 14} preserveAspectRatio="xMidYMin slice" />
                ) : null}
                <text class="fm-name" x={NODE_WIDTH / 2} y={shots[n.id] ? NODE_HEIGHT - 4 : NODE_HEIGHT / 2 + 4} text-anchor="middle">
                  {short(n.name, NAME_CHARS)}
                </text>
                {n.moreGaps > 0 && (
                  <text class="fm-more" x={NODE_WIDTH + 14} y={NODE_HEIGHT - 2}>
                    +{n.moreGaps}
                  </text>
                )}
                {(tokensOn.get(n.id) ?? []).map((t, i) => (
                  <circle class="fm-token" cx={8 + i * (TOKEN * 2 + 2)} cy={8} r={TOKEN} fill={colorOf(t.slot)}>
                    <title>{t.name}</title>
                  </circle>
                ))}
                {end && (
                  <text class={`fm-end ${end.reached ? 'ok' : 'bad'}`} x={NODE_WIDTH - 8} y={12} text-anchor="middle">
                    {end.reached ? '✓' : '✕'}
                  </text>
                )}
                {pulse?.label && (
                  <text class="fm-pulse-label" x={NODE_WIDTH / 2} y={NODE_HEIGHT + 12} text-anchor="middle">
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
      {flow.error && <p class="muted small">The paths did not load: {flow.error}</p>}
    </Section>
  );
}
