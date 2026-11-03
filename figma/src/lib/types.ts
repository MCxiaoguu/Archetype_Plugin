/**
 * Plain data the main thread reads from the open page and sends to the panel.
 * Everything here is serialisable (it crosses postMessage) and free of Figma
 * types, so the pure modules can be tested with hand written fixtures.
 */

export type NavigationKind = 'NAVIGATE' | 'SWAP' | 'OVERLAY' | 'SCROLL_TO' | 'CHANGE_TO';

export type HotspotAction =
  | { kind: 'node'; navigation: NavigationKind; destinationId: string | null }
  | { kind: 'back' }
  | { kind: 'close' }
  | { kind: 'url'; url: string }
  | { kind: 'other'; type: string };

export interface FrameInfo {
  id: string;
  name: string;
  /** The overlay closes when the person clicks outside it. */
  closesOnOutsideClick?: boolean;
}

export interface HotspotInfo {
  /** Node id of the layer that carries the interaction. */
  id: string;
  name: string;
  /** Figma node type, for example "INSTANCE" or "TEXT". */
  type: string;
  /** The top level frame the layer sits in. */
  frameId: string;
  trigger: string;
  actions: HotspotAction[];
  /** The first text inside the layer, to suggest a better name. */
  textHint?: string | null;
}

export interface DestinationInfo {
  exists: boolean;
  /** The top level frame that contains the destination, when it exists on this page. */
  frameId: string | null;
}

export interface FlowStart {
  nodeId: string;
  name: string;
}

export interface DocSnapshot {
  fileName: string;
  pageId: string;
  pageName: string;
  frames: FrameInfo[];
  flowStarts: FlowStart[];
  hotspots: HotspotInfo[];
  destinations: Record<string, DestinationInfo>;
  /** True when the page had more interactive layers than the reader keeps. */
  truncated?: boolean;
}

export interface NodeRef {
  id: string;
  name: string;
}
