import { describe, expect, it } from 'vitest';
import { runPreflight } from '../src/lib/preflight';
import { EMPTY_FORM, RUN_SIZES, buildStudyRequest, clip, icpLabel, productDescription, validateForm, type StudyForm } from '../src/lib/study';
import { fixtureDoc } from './helpers';

const KEY = 'AbCdEfGh1234567890XyZ';
const form: StudyForm = {
  startId: '1:2',
  goalId: '2:50',
  goal: 'Connect a business bank account so invoices can be paid by bank transfer',
  who: 'Founders of 2 to 10 person B2B SaaS teams who do their own bookkeeping. They have no finance hire.',
  product: 'Invoicing for small B2B teams.',
  link: `https://www.figma.com/design/${KEY}/Farside-billing?node-id=0-1`,
  size: 'quick',
};

describe('study request', () => {
  const doc = fixtureDoc();
  const preflight = runPreflight(doc, form.startId, form.goalId);

  it('builds the POST /api/studies body from the contract', () => {
    const body = buildStudyRequest(form, { doc, preflight, pluginVersion: '0.1.0', knownFileKey: null });
    expect(body).toEqual({
      title: 'Connect a business bank account so invoices can be paid by bank transfer',
      icp: {
        label: 'Founders of 2 to 10 person B2B SaaS teams',
        description: 'Founders of 2 to 10 person B2B SaaS teams who do their own bookkeeping. They have no finance hire.',
      },
      task: {
        goal: form.goal,
        url: `https://www.figma.com/proto/${KEY}/Farside-billing?node-id=1-2&starting-point-node-id=1%3A2&scaling=scale-down`,
        preconditions: [],
      },
      success: {
        criterion: 'Reaches the "Bank connected" screen',
        checks: [{ type: 'frame_reached', value: '2:50', required: true, rationale: 'The prototype shows the goal frame' }],
      },
      context: {
        productDescription: 'Invoicing for small B2B teams.',
        keyFeatures: ['Dashboard', 'Billing settings', 'Connect bank', 'Verify phone', 'Bank connected'],
      },
      design: { mode: 'ofat_stress', archetypeBudget: 5, repeatPolicy: 'explore' },
      source: 'figma',
      execution: 'plugin',
      figma: {
        fileKey: KEY,
        startNodeId: '1:2',
        targetNodeId: '2:50',
        flowName: 'Connect a bank',
        pluginVersion: '0.1.0',
        fileName: 'Farside billing',
        pageName: 'Prototype',
      },
    });
  });

  it('runs in the panel without a share link: no file key and no task URL, named by the file and page', () => {
    const body = buildStudyRequest({ ...form, link: '  ' }, { doc, preflight, pluginVersion: '0.1.0', knownFileKey: null });
    expect(body.execution).toBe('plugin');
    expect(body.task).toEqual({ goal: form.goal, preconditions: [] });
    expect(body.figma).toEqual({
      startNodeId: '1:2',
      targetNodeId: '2:50',
      flowName: 'Connect a bank',
      pluginVersion: '0.1.0',
      fileName: 'Farside billing',
      pageName: 'Prototype',
    });
  });

  it('clips the file and page names to the backend limit', () => {
    const d = { ...fixtureDoc(), fileName: 'F'.repeat(130), pageName: 'P'.repeat(130) };
    const body = buildStudyRequest({ ...form, link: '' }, { doc: d, preflight, pluginVersion: '0', knownFileKey: null });
    expect([body.figma.fileName.length, body.figma.pageName.length]).toEqual([120, 120]);
  });

  it('offers Single persona, Quick and Thorough, in that order, each with an honest time', () => {
    expect(Object.keys(RUN_SIZES)).toEqual(['single', 'quick', 'thorough']);
    expect(RUN_SIZES.single).toEqual({
      mode: 'single', archetypeBudget: 1, repeatPolicy: 'explore', label: 'Single persona', detail: 'One synthetic user, one try, fastest', estimate: 'Takes about 1 to 3 minutes',
    });
    expect(RUN_SIZES.quick.estimate).toBe('Takes about 5 to 10 minutes');
    expect(RUN_SIZES.thorough.estimate).toBe('Takes about 15 to 30 minutes');
    expect(EMPTY_FORM.size).toBe('quick');
  });

  it('asks for a one-persona study with the single design', () => {
    const body = buildStudyRequest({ ...form, size: 'single' }, { doc, preflight, pluginVersion: '0.1.0', knownFileKey: null });
    expect(body.design).toEqual({ mode: 'single', archetypeBudget: 1, repeatPolicy: 'explore' });
    // The persona is built from who the designer said their user is.
    expect(body.icp.description).toBe(form.who);
  });

  it('uses the thorough design and a null flow name off a flow start', () => {
    const body = buildStudyRequest({ ...form, startId: '2:10', size: 'thorough' }, { doc, preflight: runPreflight(doc, '2:10', '2:50'), pluginVersion: '1.2.3', knownFileKey: KEY });
    expect(body.design).toEqual({ mode: 'ofat_stress', archetypeBudget: 6, repeatPolicy: 'confirm' });
    expect(body.figma.flowName).toBeNull();
    expect(body.task.url).toContain('node-id=2-10&starting-point-node-id=2%3A10');
  });

  it('clips the title to 80 characters on a word boundary', () => {
    const long = 'Compare three plans then pick the cheapest annual option and pay with a saved card from last year';
    const body = buildStudyRequest({ ...form, goal: long }, { doc, preflight, pluginVersion: '0', knownFileKey: null });
    expect(body.title.length).toBeLessThanOrEqual(80);
    expect(long.startsWith(body.title)).toBe(true);
    expect(body.task.goal).toBe(long);
  });

  it('refuses to build with a link that is not valid, or without frames', () => {
    expect(() => buildStudyRequest({ ...form, link: 'nope' }, { doc, preflight, pluginVersion: '0', knownFileKey: null })).toThrow();
    expect(() => buildStudyRequest({ ...form, goalId: null }, { doc, preflight, pluginVersion: '0', knownFileKey: null })).toThrow();
  });

  it('clips the Figma fields to the backend limits', () => {
    const d = fixtureDoc();
    d.flowStarts = [{ nodeId: '1:2', name: 'F'.repeat(150) }];
    const body = buildStudyRequest(form, { doc: d, preflight, pluginVersion: '1.2.3-beta.4567890123456', knownFileKey: null });
    expect(body.figma.flowName?.length).toBe(120);
    expect(body.figma.pluginVersion.length).toBe(20);
  });

  it('describes the prototype even without a product line', () => {
    expect(productDescription('')).toBe('');
    expect(productDescription('Supplies for offices!!')).toBe('Supplies for offices.');
    // No note about the prototype medium: it skewed factor identification.
    expect(productDescription('A quit smoking app')).not.toMatch(/prototype/i);
  });
});

describe('form validation', () => {
  const doc = fixtureDoc();
  it('accepts a complete form', () => {
    expect(validateForm(form, runPreflight(doc, '1:2', '2:50'), null)).toEqual({});
  });

  it('names every missing piece, and the share link is not one of them', () => {
    const errs = validateForm(EMPTY_FORM, runPreflight(doc, null, null), null);
    expect(Object.keys(errs).sort()).toEqual(['goal', 'goalText', 'start', 'who']);
    expect(validateForm({ ...form, link: '' }, runPreflight(doc, '1:2', '2:50'), null)).toEqual({});
  });

  it('still checks a share link that is given', () => {
    expect(validateForm({ ...form, link: 'nope' }, runPreflight(doc, '1:2', '2:50'), null).link).toMatch(/figma\.com link/);
  });

  it('flags an unreachable goal and a link to another file', () => {
    const errs = validateForm({ ...form, goalId: '4:1' }, runPreflight(doc, '1:2', '4:1'), 'SomeOtherKey12345');
    expect(errs.flow).toBeDefined();
    expect(errs.link).toMatch(/different file/);
    expect(validateForm({ ...form, goalId: '3:1' }, runPreflight(doc, '1:2', '3:1'), null).flow).toMatch(/overlay/);
  });

  it('puts a component set start or goal on its own field', () => {
    const d = fixtureDoc();
    d.frames.push({ id: '8:1', name: 'Button', notAScreen: 'component_set' });
    const errs = validateForm({ ...form, goalId: '8:1' }, runPreflight(d, '1:2', '8:1'), null);
    expect(errs.goal).toMatch(/component set/);
    expect(errs.flow).toBeUndefined();
    expect(validateForm({ ...form, startId: '8:1' }, runPreflight(d, '8:1', '2:50'), null).start).toMatch(/component set/);
  });

  it('limits long text', () => {
    const errs = validateForm({ ...form, goal: 'x'.repeat(1001), who: 'y'.repeat(2001), product: 'z'.repeat(3001) }, null, null);
    expect(Object.keys(errs).sort()).toEqual(['goalText', 'product', 'who']);
  });
});

describe('text helpers', () => {
  it('clips without cutting words', () => {
    expect(clip('one two three', 7)).toBe('one two');
    expect(clip('short', 10)).toBe('short');
    expect(clip('abcdefghij', 4)).toBe('abcd');
  });

  it('labels the ICP with its first clause', () => {
    expect(icpLabel('Office managers, who order supplies monthly.')).toBe('Office managers');
    expect(icpLabel('Nurses on night shifts (mostly 30 to 50)')).toBe('Nurses on night shifts');
    expect(icpLabel('Busy parents. They shop on phones.')).toBe('Busy parents');
    expect(icpLabel('x'.repeat(100)).length).toBe(60);
  });
});
