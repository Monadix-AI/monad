import { expect, test } from 'bun:test';
import { join } from 'node:path';

interface WorkflowJob {
  'runs-on': string[];
  steps: Array<{ name?: string; run?: string; env?: Record<string, string> }>;
}

test('real VM workflow binds each platform to its runner, safety checks, conformance run, and bounded log', async () => {
  const path = join(import.meta.dir, '../../../../.github/workflows/sandbox-vm-real.yml');
  const workflow = Bun.YAML.parse(await Bun.file(path).text()) as { jobs: Record<string, WorkflowJob> };

  expect(
    Object.entries(workflow.jobs).map(([id, job]) => ({
      id,
      runsOn: job['runs-on'],
      generationRuns: job.steps.filter((step) => step.run === 'bun run generate').length,
      safetySteps: job.steps
        .filter((step) => step.name && /Preflight|rollback|conformance|Bound diagnostic/.test(step.name))
        .map((step) => ({ env: step.env, name: step.name, run: step.run }))
    }))
  ).toEqual([
    {
      id: 'linux-kvm',
      runsOn: ['self-hosted', 'linux', 'x64', 'monad-vm', 'kvm'],
      generationRuns: 1,
      safetySteps: [
        {
          env: undefined,
          name: 'Preflight KVM toolchain',
          run: 'bun packages/sandbox-vm/test/smoke/vm-preflight.ts'
        },
        {
          env: undefined,
          name: 'Verify failed boot rollback',
          run: 'bun packages/sandbox-vm/test/smoke/vm-boot-rollback.ts'
        },
        {
          env: { MONAD_VM_IT: '1' },
          name: 'Real KVM conformance',
          run: expect.stringContaining('bun run --cwd packages/sandbox-vm test:e2e')
        },
        {
          env: undefined,
          name: 'Bound diagnostic artifact',
          run: expect.stringContaining('1048576')
        }
      ]
    },
    {
      id: 'macos-vfkit',
      runsOn: ['self-hosted', 'macos', 'arm64', 'monad-vm', 'vfkit'],
      generationRuns: 1,
      safetySteps: [
        {
          env: undefined,
          name: 'Preflight vfkit toolchain',
          run: 'bun packages/sandbox-vm/test/smoke/vm-preflight.ts'
        },
        {
          env: undefined,
          name: 'Verify failed boot rollback',
          run: 'bun packages/sandbox-vm/test/smoke/vm-boot-rollback.ts'
        },
        {
          env: { MONAD_VM_IT: '1' },
          name: 'Real vfkit conformance',
          run: expect.stringContaining('bun run --cwd packages/sandbox-vm test:e2e')
        },
        {
          env: undefined,
          name: 'Bound diagnostic artifact',
          run: expect.stringContaining('1048576')
        }
      ]
    },
    {
      id: 'windows-hyperv',
      runsOn: ['self-hosted', 'windows', 'x64', 'monad-vm', 'hyperv'],
      generationRuns: 1,
      safetySteps: [
        {
          env: undefined,
          name: 'Preflight Hyper-V toolchain',
          run: 'bun packages/sandbox-vm/test/smoke/vm-preflight.ts'
        },
        {
          env: undefined,
          name: 'Verify failed boot rollback',
          run: 'bun packages/sandbox-vm/test/smoke/vm-boot-rollback.ts'
        },
        {
          env: { MONAD_VM_IT: '1' },
          name: 'Real Hyper-V conformance',
          run: expect.stringContaining('bun run --cwd packages/sandbox-vm test:e2e')
        },
        {
          env: undefined,
          name: 'Bound diagnostic artifact',
          run: expect.stringContaining('1048576')
        }
      ]
    }
  ]);
});
