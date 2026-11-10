import { vi } from 'vitest';

/** What the nodes of one fake file share: the node index, and the API flags that change what a node shows. */
export interface FakeWorld {
  nodes: Map<string, FakeNode>;
  flags: { skipInvisibleInstanceChildren: boolean };
  /** Where clones and new nodes land, as on `figma.currentPage`. */
  currentPage?: FakeNode | null;
  /** Calls in order, for tests that check what happened when ("remove S:1", "commitUndo"). */
  log?: string[];
  nextId?: () => string;
  /** Makes `exportAsync` throw, return no bytes, or return more than a turn may carry; a function decides per exported node. */
  exportFails?: ExportFailure | ((node: FakeNode) => ExportFailure) | null;
  /** `exportAsync` answers in a later task, as Figma's does, so changes made before it reach `nodechange` first. */
  exportsLater?: boolean;
  /** Records a node made or removed, for the next `nodechange` of its page (fakeFromFixture's pages). */
  changed?: (type: 'CREATE' | 'DELETE', node: FakeNode) => void;
}

type ExportFailure = 'throw' | 'empty' | 'huge' | null;

/** Figma names a layer inside an instance `I<instance>;<path>`: the instance's id, with one `I` in front, and the layer's path in its component. */
const instancePrefix = (instanceId: string) => `${instanceId.startsWith('I') ? instanceId : `I${instanceId}`};`;

/** A layer's path inside the component or instance it is shown in. */
function localPath(child: FakeNode, container: FakeNode): string {
  if (container.type !== 'INSTANCE') return child.id.replace(/^I/, '');
  const prefix = instancePrefix(container.id);
  if (!child.id.startsWith(prefix)) throw new Error(`Fixture: ${child.id} inside instance ${container.id} should start with ${prefix}`);
  return child.id.slice(prefix.length);
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
  private _x = 0;
  private _y = 0;
  private _layoutMode: string | undefined = undefined;
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

  /**
   * As in Figma, with `skipInvisibleInstanceChildren` on, hidden layers
   * inside instances can't be reached. A library component whose layers
   * aren't in the file (`unloaded`) can't be read until it is imported.
   */
  get children(): FakeNode[] {
    if (this.unloaded) throw new Error(`The layers of ${this.name} aren't loaded in this file`);
    if (this.world?.flags.skipInvisibleInstanceChildren && this.inInstance()) return this.kids.filter((k) => k.visible);
    return this.kids;
  }

  private inInstance(): boolean {
    for (let n: FakeNode | null = this; n; n = n.parent) if (n.type === 'INSTANCE') return true;
    return false;
  }

  /**
   * Figma refuses to move a layer inside an instance or change its auto
   * layout: "Position of any layers within the component, including items
   * in an auto layout frame" can't be overridden. Nodes being built or
   * copied aren't attached yet, so they aren't checked.
   */
  private refuseInInstance(what: string, withSelf: boolean): void {
    if (!this.parent) return;
    for (let n: FakeNode | null = withSelf ? this : this.parent; n; n = n.parent) {
      if (n.type === 'INSTANCE') throw new Error(`Can't set ${what} of ${this.id}: it is inside the instance ${n.id}`);
    }
  }

  get x(): number {
    return this._x;
  }
  set x(v: number) {
    this.refuseInInstance('x', false);
    this._x = v;
  }
  get y(): number {
    return this._y;
  }
  set y(v: number) {
    this.refuseInInstance('y', false);
    this._y = v;
  }
  get layoutMode(): string | undefined {
    return this._layoutMode;
  }
  set layoutMode(v: string | undefined) {
    this.refuseInInstance('layoutMode', true);
    this._layoutMode = v;
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

  private get w(): FakeWorld {
    if (!this.world) throw new Error(`Fake node ${this.id} belongs to no world`);
    return this.world;
  }

  /**
   * A deep copy with new ids, placed on the current page as Figma does.
   * Layers inside instances get Figma's instance ids, and a component
   * inside the copied node becomes an instance of it, as Figma's clone does.
   */
  clone(): FakeNode {
    const copy = this.copyAs(this.w.nextId?.() ?? `${this.id}-copy`, null, null, true);
    this.w.currentPage?.add(copy);
    this.w.log?.push(`clone ${copy.id}`);
    this.w.changed?.('CREATE', copy);
    return copy;
  }

  private copyAs(id: string, instanceCopy: FakeNode | null, instanceOriginal: FakeNode | null, root = false): FakeNode {
    const becomesInstance = !root && this.type === 'COMPONENT' && !instanceCopy;
    const copy = new FakeNode(id, this.name, becomesInstance ? 'INSTANCE' : this.type);
    for (const [k, v] of Object.entries(this)) {
      if (k === 'id' || k === 'parent' || k === 'world' || k === 'kids' || typeof v === 'function') continue;
      // figma.mixed is a symbol, which can't be cloned.
      copy[k] = typeof v === 'symbol' ? v : structuredClone(v);
    }
    if (becomesInstance) copy.mainComponentId = this.id;
    copy.world = this.world;
    this.w.nodes.set(id, copy);
    const [into, from] = copy.type === 'INSTANCE' ? [copy, this as FakeNode] : [instanceCopy, instanceOriginal];
    for (const kid of this.kids) {
      const kidId = into && from ? instancePrefix(into.id) + localPath(kid, from) : (this.w.nextId?.() ?? `${kid.id}-copy`);
      copy.add(kid.copyAs(kidId, into, from));
    }
    return copy;
  }

  /** Turns this instance into a plain frame in its place: every layer in it gets a new id; nested instances stay instances. */
  detachInstance(): FakeNode {
    if (this.type !== 'INSTANCE') throw new Error(`${this.id} isn't an instance`);
    const frame = this.copyAs(this.w.nextId?.() as string, null, null, true);
    this.w.log?.push(`detach ${this.id} ${frame.id}`);
    this.w.changed?.('DELETE', this);
    frame.type = 'FRAME';
    frame.mainComponentId = null;
    frame.kids = [];
    for (const kid of this.kids) frame.add(kid.copyAs(this.w.nextId?.() as string, null, null));
    const parent = this.parent;
    if (parent) {
      const at = parent.kids.indexOf(this);
      parent.kids.splice(at, 1, frame);
      frame.parent = parent;
    }
    this.parent = null;
    this.removed = true;
    this.w.nodes.delete(this.id);
    this.w.changed?.('CREATE', frame);
    return frame;
  }

  /** Sets component properties on an instance; a literal value replaces a variable bound to the property. */
  setProperties(properties: Record<string, unknown>): void {
    if (this.type !== 'INSTANCE') throw new Error(`${this.id} isn't an instance`);
    const props = structuredClone((this.componentProperties as Record<string, Record<string, unknown>>) ?? {});
    const bound = structuredClone((this.boundVariables as Record<string, unknown>) ?? {});
    const boundProps = (bound.componentProperties as Record<string, unknown>) ?? {};
    for (const [name, value] of Object.entries(properties)) {
      if (!props[name]) throw new Error(`${this.id} has no component property ${name}`);
      props[name] = { ...props[name], value };
      delete (props[name] as Record<string, unknown>).boundVariables;
      delete boundProps[name];
    }
    this.componentProperties = props;
    this.boundVariables = { ...bound, componentProperties: boundProps };
  }

  /** Shows another component in this instance: its layers replace the instance's, under Figma's instance ids. */
  swapComponent(component: FakeNode): void {
    this.w.log?.push(`swap ${this.id} ${component.id}`);
    this.mainComponentId = component.id;
    this.reactions = structuredClone(component.reactions);
    if (component.fills !== undefined) this.fills = structuredClone(component.fills);
    for (const kid of this.kids) kid.parent = null;
    this.kids = [];
    for (const kid of component.children) this.add(kid.copyAs(instancePrefix(this.id) + localPath(kid, component), this, component));
  }

  appendChild(child: FakeNode): void {
    if (child.parent) child.parent.kids = child.parent.kids.filter((k) => k !== child);
    this.add(child);
  }

  remove(): void {
    this.w.log?.push(`remove ${this.id}`);
    this.w.changed?.('DELETE', this);
    if (this.parent) this.parent.kids = this.parent.kids.filter((k) => k !== this);
    this.parent = null;
    const forget = (n: FakeNode) => {
      n.removed = true;
      this.w.nodes.delete(n.id);
      n.kids.forEach(forget);
    };
    forget(this);
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  getRangeAllFontNames(): unknown[] {
    return [this.fontName];
  }

  setExplicitVariableModeForCollection(collection: unknown, modeId: string): void {
    // With dynamic page access, Figma refuses the deprecated form that takes a collection id.
    if (typeof collection === 'string') throw new Error('Pass a variable collection, not its id');
    this.explicitVariableModes = { ...(this.explicitVariableModes as Record<string, string>), [(collection as { id: string }).id]: modeId };
  }

  setBoundVariable(field: string, variable: unknown): void {
    const bound = { ...((this.boundVariables as Record<string, unknown>) ?? {}) };
    if (variable === null) delete bound[field];
    else bound[field] = { type: 'VARIABLE_ALIAS', id: (variable as { id: string }).id };
    this.boundVariables = bound;
  }

  /** What the export draws, as JSON bytes, so tests can see what was rendered. */
  async exportAsync(settings: unknown): Promise<Uint8Array> {
    this.w.log?.push(`export ${this.id} ${JSON.stringify(settings)} skipInvisible=${this.w.flags.skipInvisibleInstanceChildren}`);
    if (this.w.exportsLater) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const fails = typeof this.w.exportFails === 'function' ? this.w.exportFails(this) : this.w.exportFails;
    if (fails === 'throw') throw new Error('Export failed');
    if (fails === 'empty') return new Uint8Array();
    if (fails === 'huge') return new Uint8Array(Math.round(1.6 * 1024 * 1024));
    return new TextEncoder().encode(JSON.stringify(this.drawn()));
  }

  drawn(): Record<string, unknown> {
    const out: Record<string, unknown> = { id: this.id, name: this.name, x: this.x, y: this.y, width: this.width, height: this.height, visible: this.visible };
    for (const k of ['type', 'characters', 'fills', 'opacity', 'explicitVariableModes', 'layoutMode', 'minWidth', 'strokeTopWeight', 'gridRowGap', 'componentProperties']) {
      if (this[k] !== undefined && this[k] !== '') out[k] = this[k];
    }
    if (this.kids.length) out.children = this.kids.map((k) => k.drawn());
    return out;
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

type NodeChangeHandler = (event: { nodeChanges: FakeNodeChange[] }) => void;

/** A `nodechange` change as Figma gives it: a removed node is only its id, type and `removed`. */
export interface FakeNodeChange {
  type: 'CREATE' | 'DELETE';
  id: string;
  origin: 'LOCAL';
  node: FakeNode | { id: string; type: string; removed: true };
}

interface FixtureWorld extends FakeWorld {
  changeHandlers?: Map<string, NodeChangeHandler[]>;
}

function pageOfNode(node: FakeNode): FakeNode | null {
  for (let cur: FakeNode | null = node; cur; cur = cur.parent) if (cur.type === 'PAGE') return cur;
  return null;
}

/**
 * Figma's `nodechange`: the creations and removals on a page since the
 * last event, batched and delivered after the fact (in a later task), when
 * a node created meanwhile may be gone already.
 */
function watchChanges(world: FixtureWorld) {
  const handlers = new Map<string, NodeChangeHandler[]>();
  const pending = new Map<string, Array<{ type: 'CREATE' | 'DELETE'; node: FakeNode }>>();
  world.changeHandlers = handlers;
  world.changed = (type, node) => {
    const page = pageOfNode(node);
    if (!page || !handlers.get(page.id)?.length) return;
    if (!pending.size) setTimeout(flush, 0);
    pending.get(page.id)?.push({ type, node }) ?? pending.set(page.id, [{ type, node }]);
  };
  function flush() {
    const batches = [...pending];
    pending.clear();
    for (const [pageId, changes] of batches) {
      const nodeChanges = changes.map(({ type, node }): FakeNodeChange => ({
        type,
        id: node.id,
        origin: 'LOCAL',
        node: node.removed ? { id: node.id, type: node.type, removed: true } : node,
      }));
      for (const handler of handlers.get(pageId) ?? []) handler({ nodeChanges });
    }
  }
}

function build(world: FixtureWorld, spec: FixtureNode): FakeNode {
  const { id, name, type, children, ...props } = spec;
  const node = new FakeNode(id, name, type);
  Object.assign(node, structuredClone(props));
  node.world = world;
  if (type === 'PAGE') {
    node.loadAsync = vi.fn(async () => {});
    node.on = vi.fn((event: string, handler: NodeChangeHandler) => {
      if (event !== 'nodechange') throw new Error(`The fake page has no ${event} event`);
      world.changeHandlers?.get(id)?.push(handler) ?? world.changeHandlers?.set(id, [handler]);
    });
  }
  world.nodes.set(id, node);
  for (const child of children ?? []) node.add(build(world, child));
  return node;
}

/** A fake file built from a prototype fixture, with the variables API, library imports and the API flags. */
export function fakeFromFixture(fixture: ProtoFixture) {
  let made = 0;
  const world: FixtureWorld = {
    nodes: new Map(),
    flags: { skipInvisibleInstanceChildren: true },
    log: [],
    nextId: () => `90:${++made}`,
    exportFails: null,
  };
  watchChanges(world);
  /** clientStorage: answered in a later task, as Figma's is, and copied both ways. */
  const storage = new Map<string, unknown>();
  const later = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const root = new FakeNode('0:0', fixture.fileName, 'DOCUMENT');
  root.world = world;
  world.nodes.set(root.id, root);
  for (const page of fixture.pages) root.add(build(world, page));
  for (const remote of fixture.remote) build(world, remote);
  /** What a library holds per key: the layers of a published component, or null when the import fails. */
  const library = new Map<string, FixtureNode | null>(Object.entries(fixture.library));

  const variables = new Map<string, Record<string, unknown>>();
  const collections = fixture.variableCollections.map((c) => {
    for (const v of c.variables) variables.set(v.id, { ...structuredClone(v), variableCollectionId: c.id });
    return { id: c.id, name: c.name, modes: c.modes, defaultModeId: c.defaultModeId, variableIds: c.variables.map((v) => v.id) };
  });

  const pages = root.children;
  world.currentPage = pages[0] as FakeNode;
  const create = (type: string, name: string) => {
    const node = new FakeNode(world.nextId?.() as string, name, type);
    node.world = world;
    world.nodes.set(node.id, node);
    world.currentPage?.add(node);
    world.log?.push(`create ${node.id}`);
    world.changed?.('CREATE', node);
    return node;
  };
  const api = {
    root,
    currentPage: pages[0] as FakeNode,
    createFrame: vi.fn(() => Object.assign(create('FRAME', 'Frame'), { fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, opacity: 1, visible: true }], clipsContent: true })),
    createRectangle: vi.fn(() => create('RECTANGLE', 'Rectangle')),
    loadFontAsync: vi.fn(async (font: unknown) => void world.log?.push(`loadFont ${JSON.stringify(font)}`)),
    commitUndo: vi.fn(() => void world.log?.push('commitUndo')),
    get skipInvisibleInstanceChildren() {
      return world.flags.skipInvisibleInstanceChildren;
    },
    set skipInvisibleInstanceChildren(v: boolean) {
      world.flags.skipInvisibleInstanceChildren = v;
    },
    getNodeByIdAsync: vi.fn(async (id: string) => world.nodes.get(id) ?? null),
    /**
     * Loads a component from its library and gives the remote component
     * node that the file holds for it: the same node on every call. A node
     * the file had without its layers gets them.
     */
    importComponentByKeyAsync: vi.fn(async (key: string) => {
      const spec = library.get(key);
      if (!spec) throw new Error(`The component ${key} isn't published in a library this file can use`);
      const held = [...world.nodes.values()].find((n) => n.key === key && n.remote);
      if (held) {
        if (held.unloaded) {
          held.unloaded = false;
          for (const child of spec.children ?? []) held.add(build(world, child));
          held.reactions = structuredClone((spec.reactions as unknown[]) ?? []);
        }
        return held;
      }
      const made = build(world, { ...spec, remote: true });
      return made;
    }),
    clientStorage: {
      getAsync: vi.fn(async (k: string) => {
        await later();
        return structuredClone(storage.get(k));
      }),
      setAsync: vi.fn(async (k: string, v: unknown) => {
        await later();
        storage.set(k, structuredClone(v));
      }),
      deleteAsync: vi.fn(async (k: string) => {
        await later();
        storage.delete(k);
      }),
    },
    variables: {
      getVariableCollectionByIdAsync: vi.fn(async (id: string) => structuredClone(collections.find((c) => c.id === id) ?? null)),
      getLocalVariableCollectionsAsync: vi.fn(async () => structuredClone(collections)),
      getVariableByIdAsync: vi.fn(async (id: string) => (variables.has(id) ? structuredClone(variables.get(id)) : null)),
    },
  };
  return { api: api as unknown as PluginAPI & typeof api, world, nodes: world.nodes, pages, storage };
}
