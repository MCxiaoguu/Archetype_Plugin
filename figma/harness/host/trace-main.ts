// The plugin's real main thread for the harness's trace requests: the fake
// Farside file (the tests' fake Figma), with trace.ts answering the panel
// as in Figma, and each render drawn as a JPEG wireframe of what it shows
// (tests/wireframe.ts), so the Running screen's Live screen and the Flow map
// show real screens. Bundled by harness/serve.mjs.
import fixtureJson from '../fixtures/farside-proto.json';
import type { MainToUi, TraceRequestMessage } from '../../src/lib/messages';
import { createTraceMain } from '../../src/main/trace';
import { fakeFromFixture, type ProtoFixture } from '../../tests/fake-figma';
import { sceneOf, type Scene } from '../../tests/wireframe';

const css = (c: { r: number; g: number; b: number }, a: number) => `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${a})`;

/** Draws a wireframe scene as a JPEG: fills and strokes as boxes, text in place, images as grey placeholders. */
async function jpeg(scene: Scene): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(Math.max(1, scene.width), Math.max(1, scene.height));
  const g = canvas.getContext('2d');
  if (!g) throw new Error('The harness cannot draw: no 2D canvas');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  for (const op of scene.ops) {
    g.save();
    g.beginPath();
    g.rect(op.clip.x, op.clip.y, op.clip.width, op.clip.height);
    g.clip();
    g.globalAlpha = op.opacity;
    const { x, y, width, height } = op.box;
    const shape = () => {
      g.beginPath();
      if ('round' in op && op.round) g.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
      else g.rect(x, y, width, height);
    };
    if (op.kind === 'fill') {
      g.fillStyle = css(op.color, op.color.a);
      shape();
      g.fill();
    } else if (op.kind === 'stroke') {
      g.strokeStyle = css(op.color, op.color.a);
      g.lineWidth = op.weight;
      shape();
      g.stroke();
    } else if (op.kind === 'image') {
      g.fillStyle = '#d9d9d9';
      g.fillRect(x, y, width, height);
    } else {
      g.fillStyle = css(op.color, op.color.a);
      g.font = `${op.size}px Inter, -apple-system, sans-serif`;
      g.textBaseline = 'middle';
      g.fillText(op.text, x, y + height / 2, width);
    }
    g.restore();
  }
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
  return new Uint8Array(await blob.arrayBuffer());
}

/** Starts the main thread on a fresh copy of the file; `post` delivers its answers to the panel. */
export function startTraceMain(post: (msg: MainToUi) => void): { handle(msg: TraceRequestMessage): Promise<void> } {
  const fake = fakeFromFixture(structuredClone(fixtureJson) as unknown as ProtoFixture);
  fake.world.exportsLater = true;
  fake.world.exportImage = (node) => jpeg(sceneOf(node));
  return createTraceMain(fake.api, post);
}
