import { expect, test } from 'bun:test';
import { join } from 'node:path';

interface WorkflowJob {
  'runs-on': string[];
  steps: Array<{ run?: string; env?: Record<string, string> }>;
}

test('real VM workflow uses only capability-labeled self-hosted runners', async () => {
  const path = join(import.meta.dir, '../../../../.github/workflows/sandbox-vm-real.yml');
  const workflow = Bun.YAML.parse(await Bun.file(path).text()) as { jobs: Record<string, WorkflowJob> };

  expect(workflow.jobs['linux-kvm']?.['runs-on']).toEqual(['self-hosted', 'linux', 'x64', 'monad-vm', 'kvm']);
  expect(workflow.jobs['macos-vfkit']?.['runs-on']).toEqual(['self-hosted', 'macos', 'arm64', 'monad-vm', 'vfkit']);
  expect(workflow.jobs['windows-hyperv']?.['runs-on']).toEqual(['self-hosted', 'windows', 'x64', 'monad-vm', 'hyperv']);
  for (const job of Object.values(workflow.jobs)) {
    expect(job.steps.some((step) => step.run?.includes('test/smoke/vm-preflight.ts'))).toBe(true);
    expect(job.steps.some((step) => step.run?.includes('test/smoke/vm-boot-rollback.ts'))).toBe(true);
    expect(job.steps.some((step) => step.run?.includes('bun run --cwd packages/sandbox-vm test:e2e'))).toBe(true);
    expect(job.steps.some((step) => step.env?.MONAD_VM_IT === '1')).toBe(true);
  }
});
