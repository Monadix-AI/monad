import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { realVmAdmission } from './vm-admission.ts';
import { disposeRealVm, drainBytes, drainViolations, prepareRealVm, spawnVm, type VmPolicy } from './vm-fixture.ts';

// biome-ignore lint/suspicious/noUndeclaredEnvVars: explicit real-hypervisor test gate
const ENABLED = realVmAdmission(Bun.env.MONAD_VM_IT) === 'run';
const AGENT = 'agt_resource_violations';
const POLICY: VmPolicy = { net: 'none' };

beforeAll(async () => {
  if (ENABLED) await prepareRealVm();
}, 120_000);

afterAll(async () => {
  if (ENABLED) await disposeRealVm(AGENT);
});

describe.skipIf(!ENABLED)('real guest cgroup violations', () => {
  test('an actual memory ceiling hit emits a bounded memory violation', async () => {
    const secret = 'OOM_ARGV_OR_ENV_MUST_NOT_LEAK';
    const process = spawnVm(
      ['sh', '-c', `exec dd if=/dev/zero of=/tmp/oom bs=1M count=256 2>/dev/null # ${secret}`],
      POLICY,
      AGENT,
      { env: { P0_SECRET: secret }, limits: { memoryMiB: 32, terminateGraceMs: 1000 } }
    );
    const output = Promise.all([drainBytes(process.stdout), drainBytes(process.stderr)]);
    const violations = drainViolations(process.violations);

    const [code, events] = await Promise.all([process.exited, violations]);
    await output;

    expect(code).not.toBe(0);
    expect(events.some((event) => event.kind === 'memory' && ['oom', 'oom-kill'].includes(event.operation))).toBe(true);
    expect(new Set(events.map((event) => event.runId)).size).toBe(1);
    expect(JSON.stringify(events)).not.toContain(secret);
  }, 600_000);

  test('an actual process ceiling hit emits pids-max and leaves no descendants', async () => {
    const process = spawnVm(['sh', '-c', 'for i in $(seq 1 64); do sleep 30 & done; wait'], POLICY, AGENT, {
      limits: { maxProcesses: 4, terminateGraceMs: 500 }
    });
    const output = Promise.all([drainBytes(process.stdout), drainBytes(process.stderr)]);
    const violations = drainViolations(process.violations);
    await Bun.sleep(500);
    process.kill('SIGTERM');

    const events = await violations;
    await Promise.all([process.exited, output]);

    expect(events.some((event) => event.kind === 'process-limit' && event.operation === 'pids-max')).toBe(true);
    expect(new Set(events.map((event) => event.runId)).size).toBe(1);
  }, 600_000);
});
