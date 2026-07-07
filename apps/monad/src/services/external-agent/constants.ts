import { EXTERNAL_AGENT_OUTPUT_SNAPSHOT_MAX } from '@monad/protocol';

/** Bytes retained from a session's output snapshot (the SQLite column + in-memory buffer bound). */
export const MAX_OUTPUT_SNAPSHOT = EXTERNAL_AGENT_OUTPUT_SNAPSHOT_MAX;

/** A running auth session is force-stopped after this long regardless of heartbeats. */
export const AUTH_RUNNING_TTL_MS = 30 * 60 * 1000;
/** A terminal (exited/failed/stopped) auth session is evicted this long after its last update. */
export const AUTH_TERMINAL_TTL_MS = 10 * 60 * 1000;
/** One-shot auth-status / usage probe budget before the child is killed and the call fails. */
export const AUTH_STATUS_TIMEOUT_MS = 20_000;
/** Default client-heartbeat grace for a running auth session (overridable via deps). */
export const DEFAULT_AUTH_HEARTBEAT_TIMEOUT_MS = 20_000;
