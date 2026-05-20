// Wire contract between main (PtyHostClient) and the PTY Host utilityProcess.
// Requests: main → host (RPC). Events: host → main (push, mirror PtyManager
// EventEmitter). Kept dependency-free so it bundles into both entries.
import type {
  AgentRunState, DetectedEvent, PaneId, Session, TerminalPane, PaneAttentionLevel
} from './types';

/** RPC: every async/void PtyManager method the client proxies. `id` correlates
 *  the reply; void methods reply with `result: undefined`. */
export interface HostRequest {
  readonly id: number;
  readonly method:
    | 'list' | 'createSession' | 'removeSession' | 'splitPane' | 'closePane'
    | 'focusPane' | 'relayout' | 'resizeSplit' | 'removeUrlFromPane'
    | 'renamePane' | 'togglePin' | 'setSessionColor' | 'renameSession'
    | 'restartAll' | 'setPaneUrl' | 'restartPane' | 'writePane'
    | 'resizePane' | 'autoRestoreSessions' | 'sessionForPane' | 'shutdown';
  readonly args: readonly unknown[];
}

export interface HostReply {
  readonly id: number;
  readonly result?: unknown;
  readonly error?: string;
}

/** Push events — names + payload tuples mirror PtyManager's `Events` type
 *  exactly so the client can re-`emit` them unchanged. `hostError` is host-internal
 *  diagnostics surfaced to main's electron-log (not a PtyManager event). */
export type HostEvent =
  | { kind: 'paneData'; paneId: PaneId; data: Uint8Array }
  | { kind: 'paneStatus'; sessionId: string; paneId: PaneId; pane: TerminalPane }
  | { kind: 'sessionUpdate'; session: Session }
  | { kind: 'urlsDetected'; paneId: PaneId; urls: string[] }
  | { kind: 'eventDetected'; event: DetectedEvent }
  | { kind: 'paneAttention'; paneId: PaneId; level: PaneAttentionLevel }
  | { kind: 'paneAgentState'; paneId: PaneId; state: AgentRunState }
  | { kind: 'hostError'; where: string; message: string };

const EVENT_KINDS = new Set<HostEvent['kind']>([
  'paneData', 'paneStatus', 'sessionUpdate', 'urlsDetected',
  'eventDetected', 'paneAttention', 'paneAgentState', 'hostError'
]);

export function isHostEvent(v: unknown): v is HostEvent {
  return (
    typeof v === 'object' && v !== null && 'kind' in v &&
    EVENT_KINDS.has((v as { kind: HostEvent['kind'] }).kind)
  );
}

export function isHostRequest(v: unknown): v is HostRequest {
  return (
    typeof v === 'object' && v !== null &&
    typeof (v as HostRequest).id === 'number' &&
    typeof (v as HostRequest).method === 'string' &&
    Array.isArray((v as HostRequest).args)
  );
}

export function isHostReply(v: unknown): v is HostReply {
  return (
    typeof v === 'object' && v !== null &&
    typeof (v as HostReply).id === 'number'
  );
}

/** Control messages carrying transferable resources (e.g. MessagePortMain) that
 *  can't travel inside a HostRequest/Reply structured-clone payload. The port
 *  itself goes via the `transfer` array of `postMessage(msg, [port])`; this
 *  envelope just declares "the next port you receive is the pane-data channel".
 *  Phase 2: only `attachDataPort` exists. */
export type HostControl =
  | { readonly kind: 'attachDataPort' };

export function isHostControl(v: unknown): v is HostControl {
  return (
    typeof v === 'object' && v !== null && 'kind' in v &&
    (v as { kind: string }).kind === 'attachDataPort'
  );
}
