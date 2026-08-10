/** Functional daemon E2E waits use generous ceilings but always return as soon as their observable
 * condition is satisfied. Performance regression thresholds belong in dedicated SLA tests instead. */
export const DAEMON_E2E_TIMEOUT_BUDGET = Object.freeze({
  testCaseMs: process.platform === 'win32' ? 45_000 : 30_000,
  conditionMs: process.platform === 'win32' ? 20_000 : 12_000,
  streamMs: process.platform === 'win32' ? 20_000 : 12_000,
  /** Auto-give-up ceiling for a service the harness wires up (oversight, clarify, delegation) when
   * the test drives the answer itself. A tight value races the answer on a loaded runner and the
   * service abandons first, so the test sees a denial it never asked for. Tests that assert the
   * give-up path pass their own short value instead. */
  serviceTimeoutMs: process.platform === 'win32' ? 30_000 : 20_000
});
