export const SNAPSHOT_FLUSH_MS = 200;
// observe() returns the whole output buffer, and a chatty CLI emits many chunks a second, so pushing
// a fresh full snapshot per chunk is quadratic bandwidth. Coalesce non-terminal pushes to this cadence.
export const OBSERVATION_THROTTLE_MS = 200;
export const HISTORY_BACKFILL_TIMEOUT_MS = 5_000;
export const MAX_STRUCTURED_LINE = 2 * 1024 * 1024;
export const HISTORY_PAGE_TIMEOUT_MS = 5_000;
export const APP_SERVER_STARTUP_TIMEOUT_MS = 15_000;
// Grace after an app-server socket drops before we treat it as a real disconnect. Process death is
// handled by `proc.exited` (which fires within this window and cleans up with the right exit state);
// if the session is still live afterward the child is alive but the socket dropped — a genuine hang.
export const APP_SERVER_DISCONNECT_GRACE_MS = 500;
export const APP_SERVER_RECONNECT_ATTEMPTS = 3;
export const APP_SERVER_RECONNECT_BASE_MS = 400;
// Cross-invocation cap on disconnect→redial cycles (see `appServerDisconnectCycles`): each
// `reconnectAppServer` call's own 3-attempt counter only bounds TRANSPORT-dial failures within that one
// call, not "transport reopens fine, app-level handshake keeps failing" — which restarts a fresh
// 3-attempt counter every cycle. This is the real ceiling for that case.
export const APP_SERVER_MAX_DISCONNECT_CYCLES = 6;
// A reconnected socket that stays up this long without dropping again is considered stable; the streak
// counter resets so a transient rough patch early in a long session doesn't count against a later,
// unrelated one.
export const APP_SERVER_RECONNECT_STREAK_RESET_MS = 10_000;
export const NATIVE_CLI_IDLE_TIMEOUT_MS = 10 * 60_000;

export type NativeCliOutputStream = 'stdout' | 'stderr' | 'pty';
