/** Functional daemon E2E waits use generous ceilings but always return as soon as their observable
 * condition is satisfied. Performance regression thresholds belong in dedicated SLA tests instead. */
export const DAEMON_E2E_TIMEOUT_BUDGET = Object.freeze({
  testCaseMs: process.platform === 'win32' ? 45_000 : 30_000,
  conditionMs: process.platform === 'win32' ? 20_000 : 12_000,
  streamMs: process.platform === 'win32' ? 20_000 : 12_000
});
