/**
 * Plain data for the trace engine: a prototype document, the engine's state,
 * the actions a persona can take and the outcomes they produce. Everything
 * here is serialisable (it crosses postMessage and goes into clientStorage)
 * and free of Figma types, so the pure modules under `lib/proto/` can be
 * tested with hand written fixtures and run in the panel, which has no
 * `figma` global. Types named after a Figma concept (`ProtoReaction`,
 * `ProtoTrigger`, `ProtoAction`) are plain mirrors of it, read once by
 * `main/protoReader.ts`; they deliberately don't share a name with the
 * Figma Plugin API type, the way `NavigationKind` doesn't share `types.ts`'s
 * `Navigation`.
 */

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

// --- ProtoDoc: what protoReader reads ---------------------------------

export type OverflowDirection = 'NONE' | 'HORIZONTAL' | 'VERTICAL' | 'BOTH';

export type OverlayPosition =
  | 'CENTER'
  | 'TOP_LEFT'
  | 'TOP_CENTER'
  | 'TOP_RIGHT'
  | 'BOTTOM_LEFT'
  | 'BOTTOM_CENTER'
  | 'BOTTOM_RIGHT'
  | 'MANUAL';

export type OverlayBackground = { type: 'NONE' } | { type: 'SOLID_COLOR'; color: RGBA };

export interface OverlaySettings {
  position: OverlayPosition;
  background: OverlayBackground;
  closeOnOutsideClick: boolean;
}

export interface ProtoFrame {
  id: string;
  name: string;
  /** The page this frame lives on; reachable frames can be on another page. */
  pageId: string;
  width: number;
  height: number;
  overflowDirection: OverflowDirection;
  numberOfFixedChildren: number;
  /** How this frame behaves when opened as an overlay. */
  overlay: OverlaySettings;
  explicitVariableModes: Record<string, string>;
}

export type KeyDevice = 'KEYBOARD' | 'XBOX_ONE' | 'PS4' | 'SWITCH_PRO' | 'UNKNOWN_CONTROLLER';

export type ProtoTrigger =
  | { type: 'ON_CLICK' | 'ON_HOVER' | 'ON_PRESS' | 'ON_DRAG' }
  | { type: 'AFTER_TIMEOUT'; delayMs: number }
  | { type: 'MOUSE_UP' | 'MOUSE_DOWN' | 'MOUSE_ENTER' | 'MOUSE_LEAVE'; delayMs: number }
  | { type: 'ON_KEY_DOWN'; device: KeyDevice; keyCodes: number[] }
  | { type: 'ON_MEDIA_HIT'; delayMs: number }
  | { type: 'ON_MEDIA_END' };

/** An expression tree: a literal, a reference to another variable, or an operator over operands. */
export type VariableExprOperator =
  | 'ADDITION'
  | 'SUBTRACTION'
  | 'MULTIPLICATION'
  | 'DIVISION'
  | 'EQUALS'
  | 'NOT_EQUAL'
  | 'LESS_THAN'
  | 'LESS_THAN_OR_EQUAL'
  | 'GREATER_THAN'
  | 'GREATER_THAN_OR_EQUAL'
  | 'AND'
  | 'OR'
  | 'NOT'
  | 'NEGATE'
  | 'VAR_MODE_LOOKUP';

export type VariableLiteral = boolean | string | number | RGBA;

export type VariableExpr =
  | { kind: 'literal'; value: VariableLiteral }
  | { kind: 'alias'; variableId: string }
  | { kind: 'op'; operator: VariableExprOperator; operands: VariableExpr[] };

export interface ConditionalBlock {
  /** Null marks the else block, run when every earlier condition is false. */
  condition: VariableExpr | null;
  actions: ProtoAction[];
}

export type ProtoNavigation = 'NAVIGATE' | 'SWAP' | 'OVERLAY' | 'SCROLL_TO' | 'CHANGE_TO';

export type ProtoAction =
  | {
      type: 'NODE';
      navigation: ProtoNavigation;
      destinationId: string | null;
      resetScrollPosition: boolean;
      /** @deprecated Figma replaced this with `resetScrollPosition`; kept for old files. */
      preserveScrollPosition: boolean;
      resetInteractiveComponents: boolean;
      /** Offset of a MANUAL overlay from the trigger's box. */
      overlayRelativePosition: { x: number; y: number } | null;
    }
  | { type: 'BACK' }
  | { type: 'CLOSE' }
  | { type: 'URL'; url: string }
  | { type: 'SET_VARIABLE'; variableId: string | null; value: VariableExpr | null }
  | { type: 'SET_VARIABLE_MODE'; collectionId: string | null; modeId: string | null }
  | { type: 'CONDITIONAL'; blocks: ConditionalBlock[] }
  | { type: 'UPDATE_MEDIA_RUNTIME' }
  /** Any action type the reader doesn't model, kept instead of dropped silently. */
  | { type: 'UNKNOWN'; rawType: string };

export interface ProtoReaction {
  trigger: ProtoTrigger;
  actions: ProtoAction[];
}

export interface ProtoVariant {
  id: string;
  name: string;
  /**
   * The reactions of the variant's layers, keyed by each layer's path
   * inside the variant (see `RawLayer.key`); '' is the variant itself.
   */
  reactions: Record<string, ProtoReaction[]>;
  /** Set when a library variant couldn't be imported; CHANGE_TO to it is `unsupported`. */
  unavailable?: boolean;
}

/**
 * Keyed in `ProtoDoc.variantSets` by the key of the instance a CHANGE_TO
 * targets: its node id, or for an instance inside a swapped variant its
 * path key (see `RawLayer.key`).
 */
export interface VariantSet {
  /** The top level frame the instance is in, whose showing starts its variant's AFTER_TIMEOUT timers. */
  frameId: string;
  variants: ProtoVariant[];
}

export type VariableValue = VariableLiteral | { alias: string };

/** The variable types a prototype can evaluate and assign (Figma's `resolvedType`). */
export type VariableType = 'BOOLEAN' | 'FLOAT' | 'STRING' | 'COLOR';

export interface VariableDef {
  id: string;
  name: string;
  resolvedType: VariableType;
  valuesByMode: Record<string, VariableValue>;
}

export interface VariableCollection {
  id: string;
  name: string;
  modes: Array<{ modeId: string; name: string }>;
  defaultModeId: string;
  variables: Record<string, VariableDef>;
}

export interface ProtoDoc {
  /** Hash of everything below, used to notice when the file changed underneath a resumed run. */
  docHash: string;
  pageId: string;
  pageName: string;
  explicitVariableModes: Record<string, string>;
  frames: ProtoFrame[];
  /** Every reaction of every layer, keyed by the layer's node id. */
  reactions: Record<string, ProtoReaction[]>;
  variantSets: Record<string, VariantSet>;
  variableCollections: Record<string, VariableCollection>;
}

// --- TraceState: what the engine carries between actions --------------

export interface ScrollOffset {
  x: number;
  y: number;
}

export interface FrameScroll extends ScrollOffset {
  /** Offsets of the frame's nested scrollable layers, by layer key. */
  areas: Record<string, ScrollOffset>;
}

/**
 * Per top level frame id: its page offset (used for the base frame only)
 * and its nested areas. A frame that never scrolled has no entry, which
 * means zero offsets. Keeping areas under their frame lets a navigation
 * reset everything under its destination.
 */
export type TraceScroll = Record<string, FrameScroll>;

export interface OpenOverlay {
  frameId: string;
  position: OverlayPosition;
  /** The overlay's top left corner in viewport coordinates, worked out when it opened. */
  origin: Point;
  closeOnOutsideClick: boolean;
}

/**
 * Values that SET_VARIABLE assigned, per collection, then per mode, then
 * per variable. A variable with no assigned value has its document value.
 */
export type TraceVariables = Record<string, Record<string, Record<string, VariableLiteral>>>;

export interface TraceTimer {
  /** The layer whose reaction scheduled this timer. */
  layerKey: string;
  /** `layerKey` and the ancestors it had when the timer was set, innermost first; a CHANGE_TO looks for its instance there. */
  chain: string[];
  /** The top level frame (base or overlay) that layer was shown in. */
  frameId: string;
  triggerType: ProtoTrigger['type'];
  /** The trigger's delay or timeout. */
  delayMs: number;
  dueAtMs: number;
  /** The reaction's actions, as they were when the timer was set. */
  actions: ProtoAction[];
  /** The trigger's unclipped box when the timer was set, for a MANUAL overlay; null when it wasn't measured. */
  triggerBox: Box | null;
}

/** The effect of a "while hovering" or "while pressing" reaction, undone when the hover or press ends. */
export interface HeldEffect {
  layerKey: string;
  trigger: 'ON_HOVER' | 'ON_PRESS';
  /** The top level frame the trigger is in. */
  frameId: string;
  /** Frame ids of the overlays it opened, closed again when it's undone. */
  overlays: string[];
  /** The variant overrides it changed, with the override each had before (null: none), restored when it's undone. */
  variants: Array<{ frameId: string; instanceKey: string; previous: string | null }>;
}

export interface TracePointer {
  /** Where the pointer last moved to, in viewport coordinates. */
  point: Point | null;
  /** The layers under the pointer: the topmost hit, then its ancestors. */
  over: string[];
  /** The layer pressed, from a click's MOUSE_DOWN to its MOUSE_UP; a click is one action, so it's null between actions. */
  pressing: string | null;
  held: HeldEffect[];
}

export interface TraceState {
  frameId: string;
  /** Open overlays, topmost last. */
  overlays: OpenOverlay[];
  /** Frame ids to return to on `back`. */
  history: string[];
  scroll: TraceScroll;
  /** An override variant id per instance key, grouped by the top level frame the instance is in. */
  variants: Record<string, Record<string, string>>;
  variables: TraceVariables;
  /** The explicit mode per collection. */
  modes: Record<string, string>;
  clockMs: number;
  timers: TraceTimer[];
  pointer: TracePointer;
  docHash: string;
  /** Fixed for the whole run, like a device: see `viewportFor`. */
  viewport: Size;
  /** The layer the last click landed on, which typed keys go to; null after a click on nothing. */
  focus: { layerKey: string; frameId: string } | null;
}

// --- The action a persona can take, and what it does ------------------

export type TraceDirection = 'up' | 'down' | 'left' | 'right';
export type TraceScrollAmount = 'page' | 'half';

export type TraceAction =
  | { type: 'click'; element: string }
  | { type: 'hover'; element: string }
  | { type: 'drag'; element: string }
  | { type: 'press_key'; key: string }
  | { type: 'scroll'; element?: string; direction: TraceDirection; amount?: TraceScrollAmount }
  | { type: 'wait'; seconds: number }
  | { type: 'back' }
  | { type: 'type'; element: string; text: string }
  | { type: 'give_up'; reason: string }
  | { type: 'done'; claim: string };

export type TraceOutcome =
  | 'navigated'
  | 'swapped'
  | 'opened_overlay'
  | 'closed_overlay'
  | 'changed_state'
  | 'scrolled'
  | 'timers_fired'
  | 'nothing_happened'
  | 'scroll_at_end'
  | 'back_empty'
  | 'waited'
  | 'typed_nothing'
  | 'left_prototype'
  | 'unsupported';

export type ActResult = 'ok' | 'no_change';

/** How each `TraceOutcome` is recorded as a step's `act.result`. */
export const OUTCOME_ACT_RESULT: Record<TraceOutcome, ActResult> = {
  navigated: 'ok',
  swapped: 'ok',
  opened_overlay: 'ok',
  closed_overlay: 'ok',
  changed_state: 'ok',
  scrolled: 'ok',
  timers_fired: 'ok',
  nothing_happened: 'no_change',
  scroll_at_end: 'no_change',
  back_empty: 'no_change',
  waited: 'no_change',
  typed_nothing: 'no_change',
  left_prototype: 'no_change',
  unsupported: 'no_change',
};

// --- Rendering: measured layers and what the persona sees --------------

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** How far a scrolling frame's content reaches past the frame's own box, measured at offset zero. */
export interface ScrollArea {
  direction: Exclude<OverflowDirection, 'NONE'>;
  maxX: number;
  maxY: number;
}

/**
 * A layer as measured off a rendered copy. Layers come in paint order: a
 * later layer draws over an earlier one, and the overlays' layers follow
 * the base frame's.
 */
export interface RawLayer {
  /**
   * The original layer's id. Inside an instance whose variant was swapped,
   * `<instance key>;<path>`, where the path is the ids of the layer and its
   * ancestors inside the variant, outermost first, joined with ';'.
   */
  key: string;
  /** The Figma node type, for example "TEXT" or "INSTANCE". */
  type: string;
  name: string;
  text: string | null;
  /** In viewport coordinates, already clipped to ancestors with `clipsContent`. Hit-testing uses it. */
  box: Box;
  /** The same box before clipping. Placing a MANUAL overlay and scrolling a node into view use it. */
  unclippedBox: Box;
  /** Figma's `visible` on this layer. A transparent hotspot is visible; a hidden layer can't be hit. */
  visible: boolean;
  /**
   * Whether the layer draws anything of its own: a visible fill, stroke or
   * effect, or it is text, a vector or an image. A transparent hotspot draws
   * nothing.
   */
  paints: boolean;
  hasReactions: boolean;
  roleHint: RoleHint | null;
  parentKey: string | null;
  /** Set on a frame whose `overflowDirection` isn't NONE; the content leaves out its fixed children. */
  scroll: ScrollArea | null;
  /**
   * A fixed child of a scrolling frame ("Fix position when scrolling"): it
   * stays put while that frame scrolls. Figma keeps fixed children as their
   * own section of the frame's children (`numberOfFixedChildren`).
   */
  fixed: boolean;
}

export type RoleHint = 'button' | 'link' | 'text' | 'card' | 'input' | 'icon' | 'image';

export type ElementBox = [x: number, y: number, width: number, height: number];

/** What the persona sees: wiring is never exposed. */
export interface Element {
  id: string;
  label: string;
  role: RoleHint;
  box: ElementBox;
}

/** How an element id maps back to the layer and point an action applies to. */
export interface ElementTarget {
  layerKey: string;
  point: Point;
}
