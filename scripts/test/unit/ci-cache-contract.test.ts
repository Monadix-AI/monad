import { expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

interface WorkflowStep {
  'continue-on-error'?: boolean | string;
  'timeout-minutes'?: number | string;
  'working-directory'?: string;
  if?: string;
  name?: string;
  run?: string;
  shell?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  'continue-on-error'?: boolean | string;
  'timeout-minutes'?: number | string;
  if?: string;
  needs?: string | string[];
  outputs?: Record<string, string>;
  secrets?: 'inherit' | Record<string, string>;
  steps?: WorkflowStep[];
  strategy?: { matrix?: Record<string, unknown> };
  uses?: string;
  with?: Record<string, unknown>;
}

interface WorkflowInput {
  default?: unknown;
  description?: string;
  required?: boolean;
  type?: string;
}

interface Workflow {
  env?: Record<string, unknown>;
  jobs?: Record<string, WorkflowJob>;
  on?: {
    workflow_call?: {
      inputs?: Record<string, WorkflowInput>;
      secrets?: Record<string, { description?: string; required?: boolean }>;
    };
    workflow_dispatch?: { inputs?: Record<string, WorkflowInput> };
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

function isOptionalTimingUpload(step: WorkflowStep): boolean {
  const artifactName = step.with?.name;
  return (
    step.name === 'Upload test timings' &&
    step.if === 'always()' &&
    step['continue-on-error'] === true &&
    step.uses?.startsWith('actions/upload-artifact@') === true &&
    step.with?.path === '$'.concat('{{ runner.temp }}/monad-junit') &&
    step.with?.['if-no-files-found'] === 'ignore' &&
    typeof artifactName === 'string' &&
    artifactName.startsWith('junit-')
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
              (candidate.uses?.startsWith('actions/cache@') || candidate.uses?.startsWith('actions/cache/restore@')) &&
              /(?:\.bun\/install\/cache|bun-install-cache)/.test(String(candidate.with?.path ?? ''))
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
    { cacheConfigured: true, job: 'ci.yml:dist-tail' },
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

test('a failing CI job still persists the dependency cache it just built', async () => {
  const workflow = Bun.YAML.parse(await Bun.file(join(workflowsDir, 'ci.yml')).text()) as Workflow;

  // A red job that skips the save leaves the next run a cold install, which on Windows costs
  // minutes — the slowness would keep itself alive for as long as the job stays red.
  expect(
    Object.entries(workflow.jobs ?? {})
      .filter(([, definition]) =>
        (definition.steps ?? []).some((step) => step.uses?.startsWith('actions/cache/restore@'))
      )
      .map(([job, definition]) => {
        const save = (definition.steps ?? []).find((step) => step.uses?.startsWith('actions/cache/save@'));
        return { job, savesOnFailure: save?.if?.includes('always()') ?? false };
      })
  ).toEqual([
    { job: 'checks', savesOnFailure: true },
    { job: 'unit', savesOnFailure: true },
    { job: 'hermetic-e2e', savesOnFailure: true },
    { job: 'web-e2e', savesOnFailure: true },
    { job: 'dist-tail', savesOnFailure: true }
  ]);
});

test('Windows jobs move temporary files off the slow system volume', async () => {
  const workflow = Bun.YAML.parse(await Bun.file(join(workflowsDir, 'ci.yml')).text()) as Workflow;
  const windowsJobs = Object.entries(workflow.jobs ?? {}).filter(([, definition]) =>
    JSON.stringify(definition.strategy?.matrix ?? {}).includes('windows-latest')
  );
  const script = String(workflow.env?.WINDOWS_FAST_TEMP);

  expect(
    windowsJobs.map(([job, definition]) => {
      const steps = definition.steps ?? [];
      const redirect = steps.findIndex((step) => step.run === '$'.concat('{{ env.WINDOWS_FAST_TEMP }}'));
      return {
        job,
        // Must land before checkout so every later step, install included, sees the new TMP.
        precedesCheckout: redirect < steps.findIndex((step) => step.uses?.startsWith('actions/checkout@')),
        windowsOnly: steps[redirect]?.if === "runner.os == 'Windows'"
      };
    })
  ).toEqual(['unit', 'hermetic-e2e'].map((job) => ({ job, precedesCheckout: true, windowsOnly: true })));
  // libuv reads TMP before TEMP, so setting only one leaves os.tmpdir() on the slow volume.
  expect({
    setsBothVariables: ['TMP=', 'TEMP='].every((name) => script.includes(name)),
    // Hardcoding D: breaks on larger runners, which have no D: drive.
    derivedFromRunnerTemp: script.includes('$env:RUNNER_TEMP') && !script.includes('D:')
  }).toEqual({ setsBothVariables: true, derivedFromRunnerTemp: true });
});

test('the Bun cache lives on the same volume as the workspace', async () => {
  const workflow = Bun.YAML.parse(await Bun.file(join(workflowsDir, 'ci.yml')).text()) as Workflow;

  // Windows puts the workspace on D: and the home directory on C:. A cache under ~ cannot be
  // hard-linked into node_modules across that boundary, so every install becomes a full copy.
  const cacheSteps = Object.values(workflow.jobs ?? {}).flatMap((definition) =>
    (definition.steps ?? []).filter((step) => step.uses?.startsWith('actions/cache/'))
  );
  const exports = Object.values(workflow.jobs ?? {}).flatMap((definition) =>
    (definition.steps ?? []).filter((step) => step.run?.includes('BUN_INSTALL_CACHE_DIR'))
  );

  expect({
    steps: cacheSteps.length,
    allUnderRunnerTemp: cacheSteps.every((step) => String(step.with?.path ?? '').includes('runner.temp')),
    exportsPerJob: exports.length,
    exportsMatchTheCachedPath: exports.every((step) => step.run?.includes('$RUNNER_TEMP/bun-install-cache'))
  }).toEqual({ steps: 10, allUnderRunnerTemp: true, exportsPerJob: 5, exportsMatchTheCachedPath: true });
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

test('the cross-platform matrix is reachable without publishing a release', async () => {
  const workflow = Bun.YAML.parse(await Bun.file(join(workflowsDir, 'ci.yml')).text()) as Workflow;
  const fullGate = "github.event_name == 'merge_group' || inputs.full";

  expect(workflow.on?.workflow_dispatch?.inputs?.full).toEqual({
    default: true,
    description: 'Run the full cross-platform quality gate.',
    required: false,
    type: 'boolean'
  });
  // Dispatch defaults `full` to true, so all three matrix gates open on a manual run.
  expect({
    hermeticE2e: workflow.jobs?.['hermetic-e2e']?.if,
    webE2e: workflow.jobs?.['web-e2e']?.if,
    unitMatrixGate: String(workflow.jobs?.unit?.strategy?.matrix?.os ?? '').includes(fullGate)
  }).toEqual({ hermeticE2e: fullGate, webE2e: fullGate, unitMatrixGate: true });
});

test('every Windows job drops Defender scanning before it writes to disk', async () => {
  const workflow = Bun.YAML.parse(await Bun.file(join(workflowsDir, 'ci.yml')).text()) as Workflow;
  const windowsJobs = Object.entries(workflow.jobs ?? {}).filter(([, definition]) =>
    JSON.stringify(definition.strategy?.matrix ?? {}).includes('windows-latest')
  );

  expect(
    windowsJobs.map(([job, definition]) => {
      const [first] = definition.steps ?? [];
      return {
        job,
        first: { if: first?.if ?? null, run: first?.run ?? null, shell: first?.shell ?? null },
        // Exclusions must precede checkout, or the cache extraction and install stay scanned.
        precedesCheckout: (definition.steps ?? []).findIndex((step) => step.uses?.startsWith('actions/checkout@')) > 0
      };
    })
  ).toEqual(
    ['unit', 'hermetic-e2e'].map((job) => ({
      job,
      first: { if: "runner.os == 'Windows'", run: '$'.concat('{{ env.WINDOWS_DEFENDER_EXCLUSIONS }}'), shell: 'pwsh' },
      precedesCheckout: true
    }))
  );
  // TEMP is where the suites build their homes; RUNNER_TEMP is a different directory and
  // excluding only it leaves every test's scratch files scanned.
  const exclusions = String(workflow.env?.WINDOWS_DEFENDER_EXCLUSIONS);
  expect({
    excludesPaths: exclusions.includes('Add-MpPreference -ExclusionPath'),
    covers: ['GITHUB_WORKSPACE', 'RUNNER_TEMP', 'TEMP', 'TMP'].filter((name) => exclusions.includes(`$env:${name}`)),
    // A runner without admin rights must warn, not fail the job.
    tolerates: exclusions.includes('::warning::')
  }).toEqual({
    excludesPaths: true,
    covers: ['GITHUB_WORKSPACE', 'RUNNER_TEMP', 'TEMP', 'TMP'],
    tolerates: true
  });
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
        .filter((step) => step['continue-on-error'] !== undefined && !isOptionalTimingUpload(step))
        .map((step) => step.name ?? step.run ?? step.uses)
    }))
  ).toEqual(critical.map((job) => ({ job, continueOnError: null, softenedSteps: [] })));
  expect(workflow.jobs?.gate?.needs).toEqual(['checks', 'unit', 'hermetic-e2e', 'web-e2e', 'dist-tail', 'e2e-deps']);
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

test('the Playwright browser cache survives an unrelated dependency bump', async () => {
  const ci = (await workflows()).find(({ file }) => file === 'ci.yml')?.workflow;
  const steps = ci?.jobs?.['web-e2e']?.steps ?? [];
  const cacheStep = steps.find((step) => step.name === 'Cache Playwright browsers');
  const versionStep = steps.find((step) => step.name === 'Resolve the Playwright version');

  // The ~150 MB payload tracks the Playwright version, not the lockfile. Keying it on the lockfile
  // evicted it on every dependency update and made both shards re-download the browser.
  expect({
    key: cacheStep?.with?.key,
    path: cacheStep?.with?.path,
    resolvesFromTheInstalledPackage: versionStep?.run?.includes('@playwright/test/package.json'),
    resolvesWhereTheDependencyLives: versionStep?.['working-directory']
  }).toEqual({
    key: '$'.concat('{{ runner.os }}-playwright-$', '{{ steps.playwright-version.outputs.version }}'),
    path: '~/.cache/ms-playwright',
    resolvesFromTheInstalledPackage: true,
    resolvesWhereTheDependencyLives: 'apps/web'
  });
});

test('only the Windows unit leg is exempt from blocking, and its deadline can report a hang', async () => {
  const workflow = (await workflows()).find(({ file }) => file === 'ci.yml')?.workflow;
  const softened = Object.entries(workflow?.jobs ?? {})
    .filter(([, job]) => job['continue-on-error'] !== undefined)
    .map(([name, job]) => ({ job: name, when: job['continue-on-error'] }));

  // The exemption is deliberate and narrow: the Windows unit leg hangs intermittently in
  // apps/monad/test/unit/sessions. Pinned so it stays one named leg instead of spreading across
  // the matrix, and so the deadline stays on the step: a job-level timeout cancels rather than
  // fails, and continue-on-error absorbs a failure but not a cancellation.
  expect({
    softened,
    testStepTimeout: workflow?.jobs?.unit?.steps?.find((step) => step.name === 'Test workspace unit')?.[
      'timeout-minutes'
    ]
  }).toEqual({
    softened: [{ job: 'unit', when: '$'.concat("{{ matrix.os == 'windows-latest' }}") }],
    testStepTimeout: 10
  });
});
