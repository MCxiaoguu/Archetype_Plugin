import { describe, expect, it } from 'vitest';
import { hiddenFrameNames, namesIn } from './live-checks';
import { fakeFile } from './trace-plugin';
import { readProto } from '../src/main/protoReader';

// The live run's frame name check: a persona can only name a frame the way
// Figma names it if the name reached it. These rules keep that check from
// passing for the wrong reason or failing on plain speech.

describe('the frame names a persona cannot have read', () => {
  it('are the Farside frames whose name their own text never shows, less what the run told the persona', async () => {
    const fake = fakeFile();
    const doc = await readProto(fake.api, fake.api.currentPage, { importLibraryVariants: true });
    const told = 'Your goal: Connect your business bank account. You are done when this has happened: Reaches the "Bank connected" screen.';
    const { hidden, told: excluded } = hiddenFrameNames(fake, doc, told);
    expect(hidden).toEqual(expect.arrayContaining(['Dashboard', 'Billing settings', 'Connect bank', 'Verify phone', 'Help: What is ACH']));
    // The success criterion names the goal frame: the persona was told it.
    expect(hidden).not.toContain('Bank connected');
    expect(excluded).toEqual(['Bank connected']);
  });
});

describe('a persona naming a frame', () => {
  const names = ['Verify phone', 'Connect bank', 'Bank connected', 'Help: What is ACH'];

  it('is the frame name as Figma writes it, quoted or not', () => {
    expect(namesIn("Farside's 'Connect bank' screen was far too sparse", names)).toEqual(['Connect bank']);
    expect(namesIn('e cautious about personal data privacy. Verify phone', names)).toEqual(['Verify phone']);
    expect(namesIn('I opened Help: What is ACH and closed it.', names)).toEqual(['Help: What is ACH']);
  });

  it('is not plain speech that shares the words', () => {
    expect(namesIn('I need to get my bank connected so I can pay invoices.', names)).toEqual([]);
    expect(namesIn('I want to connect bank accounts later.', names)).toEqual([]);
    expect(namesIn('Reconnect banking soon.', names)).toEqual([]);
  });
});
