import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { configureVmBackend, vmBaselineMetrics } from '../../src/index.ts';
import { realVmAdmission } from './vm-admission.ts';
import { disposeRealVm, prepareRealVm, runSh, type VmPolicy } from './vm-fixture.ts';

// biome-ignore lint/suspicious/noUndeclaredEnvVars: explicit capable-host integration gate
const ENABLED = realVmAdmission(Bun.env.MONAD_VM_IT) === 'run' && process.platform !== 'darwin';
// biome-ignore lint/suspicious/noUndeclaredEnvVars: explicit 60-boot benchmark gate
const BENCHMARK = ENABLED && Bun.env.MONAD_VM_BASELINE_BENCH === '1';
const AGENT = 'agt_baseline_real';
let policy: VmPolicy;

beforeAll(async () => {
  if (!ENABLED) return;
  await prepareRealVm({ baseline: true });
  policy = { writableRoots: [await mkdtemp(join(tmpdir(), 'monad-vm-baseline-'))], net: 'none' };
}, 600_000);

afterAll(async () => {
  if (ENABLED) await disposeRealVm(AGENT);
}, 60_000);

describe.skipIf(!ENABLED)('pre-workload baseline capable-host conformance', () => {
  test('cold capture then restore both admit the first workload', async () => {
    expect(await runSh('printf cold', policy, AGENT)).toEqual({ code: 0, stdout: 'cold' });
    await disposeRealVm(AGENT);
    expect(await runSh('printf restored', policy, AGENT)).toEqual({ code: 0, stdout: 'restored' });
    const metrics = vmBaselineMetrics();
    expect(metrics.cold).toBeGreaterThanOrEqual(1);
    expect(metrics.restored).toBeGreaterThanOrEqual(1);
  }, 1_200_000);
});

test('vfkit explicitly remains cold-start only', () => {
  if (process.platform !== 'darwin') return;
  expect(vmBaselineMetrics().restored).toBe(0);
});

test.skipIf(!BENCHMARK)(
  'records 30 cold and 30 restore samples on one capable host',
  async () => {
    const samples = async (prefix: string, count: number) => {
      const values: number[] = [];
      for (let index = 0; index < count; index++) {
        const started = performance.now();
        expect((await runSh('true', policy, AGENT)).code).toBe(0);
        values.push(performance.now() - started);
        await disposeRealVm(AGENT);
      }
      values.sort((a, b) => a - b);
      return {
        kind: prefix,
        samples: values.length,
        p50: values[Math.floor(values.length * 0.5)],
        p95: values[Math.floor(values.length * 0.95)]
      };
    };

    configureVmBackend({ baseline: { enabled: false, maxInactiveArtifacts: 4, maxBytes: 32 * 1024 ** 3 } });
    const cold = await samples('cold', 30);
    configureVmBackend({ baseline: { enabled: true, maxInactiveArtifacts: 4, maxBytes: 32 * 1024 ** 3 } });
    expect((await runSh('true', policy, AGENT)).code).toBe(0);
    await disposeRealVm(AGENT);
    const restore = await samples('restore', 30);
    process.stdout.write(`${JSON.stringify({ cold, restore, metrics: vmBaselineMetrics() })}\n`);
    expect(cold.samples).toBe(30);
    expect(restore.samples).toBe(30);
  },
  7_200_000
);
