import { expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

interface WorkflowStep {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  secrets?: 'inherit' | Record<string, string>;
  steps?: WorkflowStep[];
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
  on?: {
    workflow_call?: {
      secrets?: Record<string, { description?: string; required?: boolean }>;
    };
  };
}

const root = join(import.meta.dir, '../../..');
const workflowsDir = join(root, '.github/workflows');

async function workflows(): Promise<Array<{ file: string; workflow: Workflow }>> {
  const files = (await readdir(workflowsDir)).filter((file) => file.endsWith('.yml')).sort();
  return Promise.all(
    files.map(async (file) => ({
      file,
      workflow: Bun.YAML.parse(await Bun.file(join(workflowsDir, file)).text()) as Workflow
    }))
  );
}

test('every Bun dependency install restores the package cache first', async () => {
  const installs = (await workflows()).flatMap(({ file, workflow }) =>
    Object.entries(workflow.jobs ?? {}).flatMap(([job, definition]) => {
      const steps = definition.steps ?? [];
      return steps.flatMap((step, index) => {
        if (!step.run?.includes('bun install')) return [];
        const cache = steps
          .slice(0, index)
          .findLast(
            (candidate) =>
              candidate.uses?.startsWith('actions/cache@') &&
              String(candidate.with?.path ?? '').includes('~/.bun/install/cache')
          );
        return [{ cacheConfigured: Boolean(cache), job: `${basename(file)}:${job}` }];
      });
    })
  );

  expect(installs).toEqual([
    { cacheConfigured: true, job: 'atom-pack-release.yml:release' },
    { cacheConfigured: true, job: 'atom-pack-release.yml:release' },
    { cacheConfigured: true, job: 'ci.yml:checks' },
    { cacheConfigured: true, job: 'ci.yml:unit' },
    { cacheConfigured: true, job: 'ci.yml:hermetic-e2e' },
    { cacheConfigured: true, job: 'ci.yml:web-e2e' },
    { cacheConfigured: true, job: 'nightly.yml:build' },
    { cacheConfigured: true, job: 'nightly.yml:live-e2e' },
    { cacheConfigured: true, job: 'npm-publish.yml:publish' },
    { cacheConfigured: true, job: 'release.yml:atom-pack' },
    { cacheConfigured: true, job: 'release.yml:build' },
    { cacheConfigured: true, job: 'sandbox-vm-real.yml:linux-kvm' },
    { cacheConfigured: true, job: 'sandbox-vm-real.yml:macos-vfkit' },
    { cacheConfigured: true, job: 'sandbox-vm-real.yml:windows-hyperv' }
  ]);
});

test('CI executes platform-sensitive test tasks instead of replaying remote results', async () => {
  const workflow = Bun.YAML.parse(await Bun.file(join(workflowsDir, 'ci.yml')).text()) as Workflow;
  const testRuns = Object.entries(workflow.jobs ?? {}).flatMap(([job, definition]) =>
    (definition.steps ?? []).flatMap((step) =>
      step.run?.includes('turbo run test') ? [{ forced: step.run.includes('--force'), job }] : []
    )
  );

  expect(testRuns).toEqual([
    { forced: true, job: 'unit' },
    { forced: true, job: 'hermetic-e2e' },
    { forced: true, job: 'web-e2e' }
  ]);
});

test('release validation receives only the Turbo remote cache secret', async () => {
  const releasePlease = Bun.YAML.parse(await Bun.file(join(workflowsDir, 'release-please.yml')).text()) as Workflow;
  const release = Bun.YAML.parse(await Bun.file(join(workflowsDir, 'release.yml')).text()) as Workflow;

  expect({
    declared: release.on?.workflow_call?.secrets,
    forwardedToCi: release.jobs?.['ci-gate']?.secrets,
    passedToRelease: releasePlease.jobs?.['release-assets']?.secrets
  }).toEqual({
    declared: {
      TURBO_TOKEN: {
        description: 'Token used to authenticate Turbo remote cache access.',
        required: false
      }
    },
    forwardedToCi: 'inherit',
    passedToRelease: { TURBO_TOKEN: '$'.concat('{{ secrets.TURBO_TOKEN }}') }
  });
});
