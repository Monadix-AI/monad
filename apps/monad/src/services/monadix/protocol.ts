// Monadix native-realtime provider protocol. Channel/event names and inbound payload schemas come
// from the shared `@monadix/realtime-protocol` package (single source of truth across the Monadix
// API, clients, and providers), re-exported here under the names the daemon's provider code uses so
// call sites stay stable. Parse every inbound Realtime broadcast against these schemas.
export {
  channels as monadixChannels,
  events as monadixEvents,
  type TaskDispatchAckPayload,
  type TaskDispatchedPayload,
  taskDispatchedPayloadSchema,
  taskFollowUpDispatchedPayloadSchema
} from '@monadix/realtime-protocol';

// The body POSTed to `{apiBase}/network/tasks/:id/result`. This is a server-side HTTP contract, not
// a Realtime broadcast, so it is NOT part of `@monadix/realtime-protocol` — kept local to the daemon.
export type SubmitResultBody =
  | { status: 'completed'; output: Record<string, unknown> | null; dispatchSecret?: string }
  | { status: 'failed'; output?: Record<string, unknown> | null; dispatchSecret?: string };
