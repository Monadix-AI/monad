// observe() returns the whole output buffer, and a chatty CLI emits many chunks a second, so pushing
// a fresh full snapshot per chunk is quadratic bandwidth. Coalesce non-terminal pushes to this cadence.
export const OBSERVATION_THROTTLE_MS = 200;
