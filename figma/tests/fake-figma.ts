import { vi } from 'vitest';

/** What the nodes of one fake file share: the node index, and the API flags that change what a node shows. */
export interface FakeWorld {
  nodes: Map<string, FakeNode>;
  flags: { skipInvisibleInstanceChildren: boolean };
}

/** A small stand in for the Figma Plugin API: enough of the node tree, storage and UI. */
export class FakeNode {
  /** Fixture properties (fills, overflowDirection, boundVariables, ...) land on the node as they are. */
  [prop: string]: unknown;
  id: string;
  name: string;
  type: string;
  parent: FakeNode | null = null;
  world: FakeWorld | null = null;
  private kids: FakeNode[] = [];
  reactions: unknown[] = [];
  visible = true;
  x = 0;
  y = 0;
  width = 0;
  height = 0;
  mainComponentId: string | null = null;
  characters = '';
  removed = false;
  overlayBackgroundInteraction = 'NONE';
  flowStartingPoints: { nodeId: string; name: string }[] = [];
  selection: FakeNode[] = [];
  private _annotations: { label?: string }[] = [];
  refuseAnnotations = false;
  private pluginData = new Map<string, string>();

  constructor(id: string, name: string, type: string) {
    this.id = id;
    this.name = name;
    this.type = type;
  }

  get annotations() {
    return this._annotations;
  }
  set annotations(v: { label?: string }[]) {
    if (this.refuseAnnotations) throw new Error('Cannot write annotations in this file');
    this._annotations = v;
  }

  /** As in Figma, with `skipInvisibleInstanceChildren` on, hidden layers inside instances can't be reached. */
  get children(): FakeNode[] {
    if (this.world?.flags.skipInvisibleInstanceChildren && this.inInstance()) return this.kids.filter((k) => k.visible);
    return this.kids;
  }

  private inInstance(): boolean {
    for (let n: FakeNode | null = this; n; n = n.parent) if (n.type === 'INSTANCE') return true;
    return false;
  }

  add(...kids: FakeNode[]): this {
    for (const k of kids) {
      k.parent = this;
      this.kids.push(k);
    }
    return this;
  }

  /** Node x and y are relative to the parent, as in Figma; pages and sections' parents start at the canvas. */
  get absoluteBoundingBox() {
    let x = 0;
    let y = 0;
    for (let n: FakeNode | null = this; n && n.type !== 'PAGE' && n.type !== 'DOCUMENT'; n = n.parent) {
      x += n.x;
      y += n.y;
    }
    return { x, y, width: this.width, height: this.height };
  }

  async getMainComponentAsync(): Promise<FakeNode | null> {
    return this.mainComponentId ? (this.world?.nodes.get(this.mainComponentId) ?? null) : null;
  }

  findAll(pred: (n: FakeNode) => boolean): FakeNode[] {
    const out: FakeNode[] = [];
    const walk = (n: FakeNode) => {
      for (const c of n.children) {
        if (pred(c)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  findOne(pred: (n: FakeNode) => boolean): FakeNode | null {
    return this.findAll(pred)[0] ?? null;
  }

  getPluginData(k: string) {
    return this.pluginData.get(k) ?? '';
  }
  setPluginData(k: string, v: string) {
    this.pluginData.set(k, v);
  }
}

export const nav = (destinationId: string | null, navigation = 'NAVIGATE') => ({
  trigger: { type: 'ON_CLICK' },
  actions: [{ type: 'NODE', destinationId, navigation, transition: null }],
});

export function makeFigma(opts: { fileKey?: string; readOnlyRoot?: boolean } = {}) {
  const root = new FakeNode('0:0', 'Farside billing', 'DOCUMENT');
  const page = new FakeNode('0:1', 'Prototype', 'PAGE');
  const other = new FakeNode('0:2', 'Archive', 'PAGE');
  root.add(page, other);

  const dash = new FakeNode('1:2', 'Dashboard', 'FRAME');
  const billingText = new FakeNode('1:7', 'Billing', 'TEXT');
  billingText.reactions = [nav('2:10')];
  const rect = new FakeNode('1:8', 'Rectangle 12', 'RECTANGLE');
  rect.reactions = [nav('3:5')];
  const group = new FakeNode('1:9', 'Nav', 'GROUP').add(billingText, rect);
  dash.add(group);

  const section = new FakeNode('5:1', 'Billing flow', 'SECTION');
  const billing = new FakeNode('2:10', 'Billing settings', 'FRAME');
  const connectBtn = new FakeNode('2:11', 'Frame 48', 'INSTANCE');
  const label = new FakeNode('2:14', 'Label', 'TEXT');
  label.characters = 'Connect a bank';
  connectBtn.add(label);
  // Conditional action: navigate only when a variable is set.
  connectBtn.reactions = [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'CONDITIONAL', conditionalBlocks: [{ actions: [{ type: 'NODE', destinationId: '2:20', navigation: 'NAVIGATE', transition: null }] }, { actions: [{ type: 'SET_VARIABLE', variableId: 'v' }] }] }] }];
  const back = new FakeNode('2:13', 'Back', 'INSTANCE');
  back.reactions = [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'BACK' }] }];
  billing.add(connectBtn, back);
  section.add(billing);

  const connect = new FakeNode('2:20', 'Connect bank', 'FRAME');
  const signIn = new FakeNode('2:21', 'Sign in with your bank', 'INSTANCE');
  // Old files only carry the deprecated single `action`.
  signIn.reactions = [{ trigger: { type: 'ON_CLICK' }, action: { type: 'NODE', destinationId: '3:1', navigation: 'OVERLAY', transition: null } }];
  const broken = new FakeNode('2:23', 'Use routing number', 'TEXT');
  broken.reactions = [nav('9:99')];
  const cont = new FakeNode('2:22', 'Continue', 'INSTANCE');
  cont.reactions = [nav('2:50')];
  const hidden = new FakeNode('2:24', 'Hotspot inside overlay target', 'FRAME');
  hidden.reactions = [nav('7:1')];
  connect.add(signIn, broken, cont, hidden);

  const done = new FakeNode('2:50', 'Bank connected', 'FRAME');
  const overlay = new FakeNode('3:1', 'Bank sign in error', 'FRAME');
  overlay.overlayBackgroundInteraction = 'CLOSE_ON_CLICK_OUTSIDE';
  const plans = new FakeNode('3:5', 'Plans', 'COMPONENT');
  const note = new FakeNode('6:1', 'Sticky note', 'TEXT');
  page.add(dash, section, connect, done, overlay, plans, note);
  page.flowStartingPoints = [{ nodeId: '1:2', name: 'Connect a bank' }];

  const archived = new FakeNode('7:1', 'Old screen', 'FRAME');
  other.add(archived);

  const all = new Map<string, FakeNode>();
  const index = (n: FakeNode) => {
    all.set(n.id, n);
    n.children.forEach(index);
  };
  index(root);

  const storage = new Map<string, unknown>();
  if (opts.readOnlyRoot) {
    root.setPluginData = () => {
      throw new Error('read only');
    };
  }
  const api = {
    fileKey: opts.fileKey,
    root,
    currentPage: page,
    getNodeByIdAsync: vi.fn(async (id: string) => all.get(id) ?? null),
    setCurrentPageAsync: vi.fn(async (p: FakeNode) => {
      api.currentPage = p;
    }),
    viewport: { scrollAndZoomIntoView: vi.fn() },
    ui: { postMessage: vi.fn(), resize: vi.fn() },
    notify: vi.fn(),
    openExternal: vi.fn(),
    clientStorage: {
      getAsync: vi.fn(async (k: string) => storage.get(k)),
      setAsync: vi.fn(async (k: string, v: unknown) => void storage.set(k, v)),
      deleteAsync: vi.fn(async (k: string) => void storage.delete(k)),
    },
  };
  return { api: api as unknown as PluginAPI & typeof api, nodes: all, storage, page, other };
}

/** A node of `harness/fixtures/farside-proto.json`: Figma's properties, with children nested. */
export interface FixtureNode {
  id: string;
  name: string;
  type: string;
  children?: FixtureNode[];
  [prop: string]: unknown;
}

export interface ProtoFixture {
  fileName: string;
  pages: FixtureNode[];
  /** Library components the file uses but doesn't own: reachable by id, on no page. */
  remote: FixtureNode[];
  /** What `importComponentByKeyAsync` gives per key; null makes the import fail. */
  library: Record<string, FixtureNode | null>;
  variableCollections: Array<{
    id: string;
    name: string;
    modes: Array<{ modeId: string; name: string }>;
    defaultModeId: string;
    variables: Array<{ id: string; name: string; resolvedType: string; valuesByMode: Record<string, unknown> }>;
  }>;
}

function build(world: FakeWorld, spec: FixtureNode): FakeNode {
  const { id, name, type, children, ...props } = spec;
  const node = new FakeNode(id, name, type);
  Object.assign(node, structuredClone(props));
  node.world = world;
  if (type === 'PAGE') node.loadAsync = vi.fn(async () => {});
  world.nodes.set(id, node);
  for (const child of children ?? []) node.add(build(world, child));
  return node;
}

/** A fake file built from a prototype fixture, with the variables API, library imports and the API flags. */
export function fakeFromFixture(fixture: ProtoFixture) {
  const world: FakeWorld = { nodes: new Map(), flags: { skipInvisibleInstanceChildren: true } };
  const root = new FakeNode('0:0', fixture.fileName, 'DOCUMENT');
  root.world = world;
  world.nodes.set(root.id, root);
  for (const page of fixture.pages) root.add(build(world, page));
  for (const remote of fixture.remote) build(world, remote);
  const library = new Map<string, FakeNode | null>();
  for (const [key, spec] of Object.entries(fixture.library)) library.set(key, spec ? build(world, spec) : null);

  const variables = new Map<string, Record<string, unknown>>();
  const collections = fixture.variableCollections.map((c) => {
    for (const v of c.variables) variables.set(v.id, { ...structuredClone(v), variableCollectionId: c.id });
    return { id: c.id, name: c.name, modes: c.modes, defaultModeId: c.defaultModeId, variableIds: c.variables.map((v) => v.id) };
  });

  const pages = root.children;
  const api = {
    root,
    currentPage: pages[0] as FakeNode,
    get skipInvisibleInstanceChildren() {
      return world.flags.skipInvisibleInstanceChildren;
    },
    set skipInvisibleInstanceChildren(v: boolean) {
      world.flags.skipInvisibleInstanceChildren = v;
    },
    getNodeByIdAsync: vi.fn(async (id: string) => world.nodes.get(id) ?? null),
    importComponentByKeyAsync: vi.fn(async (key: string) => {
      const node = library.get(key);
      if (!node) throw new Error(`The component ${key} isn't published in a library this file can use`);
      return node;
    }),
    variables: {
      getLocalVariableCollectionsAsync: vi.fn(async () => structuredClone(collections)),
      getVariableByIdAsync: vi.fn(async (id: string) => (variables.has(id) ? structuredClone(variables.get(id)) : null)),
    },
  };
  return { api: api as unknown as PluginAPI & typeof api, world, nodes: world.nodes, pages };
}
