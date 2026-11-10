import { describe, expect, it } from 'vitest';
import fixtureJson from '../harness/fixtures/farside-proto.json';
import { listElements } from '../src/lib/proto/elements';
import { apply, start } from '../src/lib/proto/engine';
import type { Box, RawLayer, TraceState } from '../src/lib/proto/model';
import { readProto } from '../src/main/protoReader';
import { createRenderer } from '../src/main/renderer';
import { fakeFromFixture, type ProtoFixture } from './fake-figma';
import { sceneOf, type Scene, type WireOp } from './wireframe';

// The live run's wireframe must show what the renderer measured: the
// scene is read from the scratch copies at export time, so its boxes are
// the measured layers' boxes, clipped the same way.

async function setup() {
  const fake = fakeFromFixture(structuredClone(fixtureJson) as unknown as ProtoFixture);
  const doc = await readProto(fake.api, fake.api.currentPage, { importLibraryVariants: true });
  const renderer = createRenderer(fake.api);
  let scene: Scene | null = null;
  fake.world.exportImage = async (node) => {
    scene = sceneOf(node);
    return new Uint8Array([0xff, 0xd8, 0xff]);
  };
  const render = async (state: TraceState) => {
    scene = null;
    const result = await renderer.render(doc, state);
    if (!scene) throw new Error('The render exported nothing');
    return { layers: result.layers, scene: scene as Scene };
  };
  // The Farside run starts on the Dashboard: its 1280 x 800 is the viewport throughout.
  const on = (frameId: string, changes: Partial<TraceState> = {}): TraceState => ({ ...start(doc, '1:2'), frameId, ...changes });
  return { doc, render, on };
}

function intersect(a: Box, b: Box): Box | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

const VIEWPORT: Box = { x: 0, y: 0, width: 1280, height: 800 };

const texts = (scene: Scene) => scene.ops.filter((op): op is Extract<WireOp, { kind: 'text' }> => op.kind === 'text');
const onScreen = (layers: RawLayer[], height: number) =>
  layers.filter((l) => l.type === 'TEXT' && l.visible && l.text?.trim() && l.box.width > 0 && l.box.y < height && l.box.y + l.box.height > 0);

describe('the wireframe scene', () => {
  it('draws every measured text where the renderer measured it, scrolled with the page', async () => {
    const { render, on } = await setup();
    const { layers, scene } = await render(on('2:20', { scroll: { '2:20': { x: 0, y: 700, areas: {} } } }));
    expect(scene).toMatchObject({ width: 1280, height: 800 });
    const measured = onScreen(layers, 800);
    expect(measured.map((l) => l.text)).toContain('Continue');
    for (const layer of measured) {
      const op = texts(scene).find((t) => t.text === layer.text && t.box.x === layer.unclippedBox.x && t.box.y === layer.unclippedBox.y);
      expect(op, `no text drawn for ${layer.text}`).toBeDefined();
      // Measured boxes run past the viewport (the element list cuts them); the picture ends at its edge.
      expect(intersect((op as WireOp).box, (op as WireOp).clip)).toEqual(intersect(layer.box, VIEWPORT));
    }
    // The fixed header stays at the top while the page scrolls.
    expect(texts(scene).find((t) => t.text === 'Connect your bank')?.box.y).toBe(32);
  });

  it('leaves hidden layers out, and draws an overlay over its dimmed backdrop', async () => {
    const { doc, render, on } = await setup();
    const connect = on('2:20');
    const { layers, scene } = await render(connect);
    // The buttons' spinners are hidden: nothing of them is drawn.
    expect(scene.ops.filter((op) => op.key.endsWith(';6:4'))).toEqual([]);

    const { elements, targets } = listElements(layers, connect);
    const signIn = elements.find((e) => e.label === 'Sign in with your bank');
    if (!signIn) throw new Error('Sign in with your bank is not listed');
    const opened = apply(doc, connect, { type: 'click', element: signIn.id }, layers, targets).state;
    const { scene: over } = await render(opened);
    const backdrop = over.ops.findIndex((op) => op.kind === 'fill' && op.color.a === 0.4 && op.box.width === 1280 && op.box.height === 800);
    const message = over.ops.findIndex((op) => op.kind === 'text' && op.text === "We couldn't reach your bank");
    expect(backdrop).toBeGreaterThan(-1);
    expect(message).toBeGreaterThan(backdrop);
  });
});
