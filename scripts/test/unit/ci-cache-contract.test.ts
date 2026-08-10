import { expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

interface WorkflowStep {
  'continue-on-error'?: boolean | string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  'continue-on-error'?: boolean | string;
  if?: string;
  needs?: string | string[];
  outputs?: Record<string, string>;
  secrets?: 'inherit' | Record<string, string>;
  steps?: WorkflowStep[];
  uses?: string;
  with?: Record<string, unknown>;
}

interface Workflow {
  env?: Record<string, unknown>;
  jobs?: Record<string, WorkflowJob>;
  on?: {
    workflow_call?: {
      inputs?: Record<string, { default?: unknown; description?: string; required?: boolean; type?: string }>;
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
    { cacheConfigured: true, job: 'nightly.yml:live-e2e' },
    { cacheConfigured: true, job: 'npm-publish.yml:publish' },
    { cacheConfigured: true, job: 'release.yml:atom-pack' },
    { cacheConfigured: true, job: 'release.yml:build' },
    { cacheConfigured: true, job: 'release.yml:upgrade-test' },
    { cacheConfigured: true, job: 'sandbox-vm-real.yml:linux-kvm' },
    { cacheConfigured: true, job: 'sandbox-vm-real.yml:macos-vfkit' },
    { cacheConfigured: true, job: 'sandbox-vm-real.yml:windows-hyperv' }
  ]);
});

test('CI caches PR tasks while the final release gate forces complete execution', async () => {
  const ci = Bun.YAML.parse(await Bun.file(join(workflowsDir, 'ci.yml')).text()) as Workflow;
  const release = Bun.YAML.parse(await Bun.file(join(workflowsDir, 'release.yml')).text()) as Workflow;
  const testRuns = Object.entries(ci.jobs ?? {}).flatMap(([job, definition]) =>
    (definition.steps ?? []).flatMap((step) =>
      step.run?.includes('turbo run test') ? [{ forced: step.run.includes('--force'), job }] : []
    )
  );

  expect(ci.on?.workflow_call?.inputs?.force).toMatchObject({ default: false, required: false, type: 'boolean' });
  expect(ci.env?.TURBO_FORCE).toBe('$'.concat("{{ inputs.force && 'true' || 'false' }}"));
  expect(testRuns).toEqual([
    { forced: false, job: 'unit' },
    { forced: false, job: 'hermetic-e2e' },
    { forced: false, job: 'web-e2e' }
  ]);
  expect(release.jobs?.['ci-gate']?.with).toMatchObject({ force: true, full: true });
});

test('CI preserves failures while running both unit test scopes', async () => {
  const workflow = Bun.YAML.parse(await Bun.file(join(workflowsDir, 'ci.yml')).text()) as Workflow;
  const steps = workflow.jobs?.unit?.steps ?? [];

  expect(
    steps
      .filter((step) => step.name?.startsWith('Test '))
      .map((step) => ({ condition: step.if ?? null, name: step.name, run: step.run }))
  ).toEqual([
    {
      condition: null,
      name: 'Test workspace unit',
      run: 'bun scripts/quiet-run.ts bunx --bun turbo run test --output-logs=errors-only'
    },
    {
      condition: '$'.concat('{{ !cancelled() }}'),
      name: 'Test script unit',
      run: 'bun scripts/bun-test.ts scripts/test/unit/ --only-failures'
    }
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

test('stable releases publish only a fully validated pending manifest version', async () => {
  const releasePlease = Bun.YAML.parse(await Bun.file(join(workflowsDir, 'release-please.yml')).text()) as Workflow;
  const release = Bun.YAML.parse(await Bun.file(join(workflowsDir, 'release.yml')).text()) as Workflow;
  const upload = release.jobs?.publish?.steps?.find((step) => step.name === 'Upload release assets');

  expect({
    stateOutputs: releasePlease.jobs?.['release-state']?.outputs,
    releasePlease: {
      if: releasePlease.jobs?.['release-please']?.if,
      needs: releasePlease.jobs?.['release-please']?.needs,
      skipGithubRelease: releasePlease.jobs?.['release-please']?.steps?.[0]?.with?.['skip-github-release']
    },
    releaseAssets: {
      if: releasePlease.jobs?.['release-assets']?.if,
      needs: releasePlease.jobs?.['release-assets']?.needs,
      with: releasePlease.jobs?.['release-assets']?.with
    },
    upload: {
      draft: upload?.with?.draft,
      targetCommitish: upload?.with?.target_commitish
    }
  }).toEqual({
    stateOutputs: {
      pending: '$'.concat('{{ steps.release.outputs.pending }}'),
      sha: '$'.concat('{{ steps.release.outputs.sha }}'),
      tag: '$'.concat('{{ steps.release.outputs.tag }}')
    },
    releasePlease: {
      if: "needs.release-state.outputs.pending != 'true'",
      needs: 'release-state',
      skipGithubRelease: true
    },
    releaseAssets: {
      if: "needs.release-state.outputs.pending == 'true'",
      needs: 'release-state',
      with: {
        make_latest: true,
        sha: '$'.concat('{{ needs.release-state.outputs.sha }}'),
        tag: '$'.concat('{{ needs.release-state.outputs.tag }}')
      }
    },
    upload: {
      draft: true,
      targetCommitish: '$'.concat('{{ inputs.sha || inputs.tag }}')
    }
  });
});

test('critical daemon and browser E2E jobs cannot be softened or omitted from the full gate', async () => {
  const workflow = Bun.YAML.parse(await Bun.file(join(workflowsDir, 'ci.yml')).text()) as Workflow;
  const critical = ['hermetic-e2e', 'web-e2e', 'e2e-deps'];

  expect(
    critical.map((job) => ({
      job,
      continueOnError: workflow.jobs?.[job]?.['continue-on-error'] ?? null,
      softenedSteps: (workflow.jobs?.[job]?.steps ?? [])
        .filter((step) => step['continue-on-error'] !== undefined)
        .map((step) => step.name ?? step.run ?? step.uses)
    }))
  ).toEqual(critical.map((job) => ({ job, continueOnError: null, softenedSteps: [] })));
  expect(workflow.jobs?.gate?.needs).toEqual(['checks', 'unit', 'hermetic-e2e', 'web-e2e', 'e2e-deps']);
  expect(JSON.stringify(critical.map((job) => workflow.jobs?.[job]))).not.toMatch(/allow[-_]?failure|quarantine/i);
});

test('daemon E2E uses the first-failure-preserving wrapper and one centralized functional timeout budget', async () => {
  const pkg = await Bun.file(join(root, 'apps/monad/package.json')).json();
  const runner = await Bun.file(join(root, 'apps/monad/scripts/run-e2e-tests.ts')).text();

  expect(pkg.scripts?.['test:e2e']).toBe('bun ../../scripts/quiet-run.ts bun scripts/run-e2e-tests.ts');
  expect(runner).toContain("'../../scripts/bun-test.ts'");
  expect(runner).toContain('DAEMON_E2E_TIMEOUT_BUDGET.testCaseMs');
  expect(runner).not.toContain('--retry');
});
