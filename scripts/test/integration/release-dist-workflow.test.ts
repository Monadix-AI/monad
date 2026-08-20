import { expect, test } from 'bun:test';
import { join, resolve } from 'node:path';

interface Step {
  env?: Record<string, string>;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface Job {
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  steps?: Step[];
  strategy?: { matrix?: { include?: Array<Record<string, string>> } };
  with?: Record<string, unknown>;
}

interface Workflow {
  jobs?: Record<string, Job>;
  on?: {
    pull_request?: { branches?: string[]; types?: string[] };
    workflow_call?: { inputs?: Record<string, unknown> };
  };
}

const root = resolve(import.meta.dir, '../../..');
const parseWorkflow = async (file: string): Promise<Workflow> =>
  Bun.YAML.parse(await Bun.file(join(root, '.github/workflows', file)).text()) as Workflow;
const release = await parseWorkflow('release.yml');
const stable = await parseWorkflow('release-please.yml');
const beta = await parseWorkflow('beta.yml');
const nightly = await parseWorkflow('nightly.yml');
const releaseSmoke = await parseWorkflow('release-smoke.yml');
const ci = await parseWorkflow('ci.yml');
const step = (workflow: Workflow, job: string, name: string): Step | undefined =>
  workflow.jobs?.[job]?.steps?.find((candidate) => candidate.name === name);

test('stable and beta publish only after Release Please creates the draft from the merged PR', () => {
  const callers = { beta: beta.jobs?.['release-assets'], stable: stable.jobs?.['release-assets'] };

  expect({
    beta: {
      if: callers.beta?.if,
      needs: callers.beta?.needs,
      permissions: callers.beta?.permissions
    },
    stable: {
      if: callers.stable?.if,
      needs: callers.stable?.needs,
      permissions: callers.stable?.permissions
    }
  }).toEqual({
    beta: {
      if: "needs.release-please.outputs.release_created == 'true'",
      needs: 'release-please',
      permissions: { attestations: 'write', contents: 'write', 'id-token': 'write' }
    },
    stable: {
      if: "needs.release-please.outputs.release_created == 'true'",
      needs: 'release-please',
      permissions: { attestations: 'write', contents: 'write', 'id-token': 'write' }
    }
  });
  expect(stable.jobs?.['release-state']).toBeUndefined();
  expect(release.jobs?.['ci-gate']).toBeUndefined();
  expect(release.jobs?.['install-test']).toBeUndefined();
  expect(release.jobs?.['upgrade-test']).toBeUndefined();
});

test('the post-merge workflow verifies, builds, attests, uploads, and publishes without a quality rerun', () => {
  const buildMatrix = release.jobs?.build?.strategy?.matrix?.include ?? [];
  const preflight = step(release, 'preflight', 'Verify release version and draft')?.run;
  const attest = step(release, 'publish', 'Attest release assets');
  const upload = step(release, 'publish', 'Upload assets to prepared release draft');
  const publish = step(release, 'publish', 'Publish release')?.run;

  expect(buildMatrix).toContainEqual({ runner: 'ubuntu-latest', target: 'aarch64-pc-windows-msvc' });
  expect(preflight).toContain('gh release view');
  expect(preflight).toContain('select(.isDraft == true)');
  expect(release.jobs?.publish?.needs).toEqual(['atom-pack', 'installers']);
  expect(attest?.uses).toMatch(/^actions\/attest@[0-9a-f]{40}$/);
  expect(attest?.with?.['subject-path']).toBe('release-assets/*');
  expect(upload?.if).toBe('$'.concat('{{ !inputs.generate_notes }}'));
  expect(upload?.run).toContain('gh release upload');
  expect(publish).toContain('--draft=false');
});

test('release PR synchronization regenerates the PR body and participates in the required gate', () => {
  const notes = ci.jobs?.['release-notes'];
  const generate = step(ci, 'release-notes', 'Generate release notes');
  const preserve = step(ci, 'release-notes', 'Preserve Release Please metadata')?.run;
  const update = step(ci, 'release-notes', 'Update release PR body')?.run;
  const gate = step(ci, 'gate', 'Verify required jobs')?.run;

  expect(ci.on?.pull_request).toEqual({
    branches: ['main', 'beta'],
    types: ['opened', 'synchronize', 'reopened', 'labeled']
  });
  expect(notes?.if).toContain('autorelease: pending');
  expect(generate?.uses).toBe('orhun/git-cliff-action@f50e11560dce63f7c33227798f90b924471a88b5');
  expect(generate?.with?.config).toBe('cliff.toml');
  expect(preserve).toContain('scripts/merge-release-pr-notes.ts');
  expect(preserve).toContain('gh api "repos/$'.concat('{GITHUB_REPOSITORY}/pulls/$', '{PR_NUMBER}" --jq .body'));
  expect(update).toContain('gh api --method PATCH');
  expect(update).toContain('--rawfile body release-notes.md');
  expect(ci.jobs?.gate?.needs).toContain('release-notes');
  expect(gate).toContain('test "$RELEASE_NOTES_RESULT" = success');
});

test('release PRs expand every quality leg and do not soften first-pass failures', () => {
  const releaseLabel = 'autorelease: pending';
  const jobs = ['unit', 'integration', 'hermetic-e2e', 'web-e2e', 'dist-tail', 'e2e-deps'];

  expect(JSON.stringify(ci.jobs?.unit?.strategy?.matrix)).toContain(releaseLabel);
  expect(JSON.stringify(ci.jobs?.integration?.strategy?.matrix)).toContain(releaseLabel);
  expect(ci.jobs?.['hermetic-e2e']?.if).toContain(releaseLabel);
  expect(ci.jobs?.['web-e2e']?.if).toContain(releaseLabel);
  expect(ci.jobs?.['e2e-deps']?.if).toContain(releaseLabel);
  expect(
    jobs.flatMap((job) => {
      const definition = ci.jobs?.[job] as (Job & { 'continue-on-error'?: unknown }) | undefined;
      return definition?.['continue-on-error'] === undefined ? [] : [job];
    })
  ).toEqual([]);
});

test('nightly gates only unit and integration before generating notes and publishing', () => {
  const quality = nightly.jobs?.quality;
  const caller = nightly.jobs?.['release-assets'];
  const gate = step(ci, 'gate', 'Verify required jobs')?.run;

  expect(quality?.with).toEqual({ nightly: true, sha: '$'.concat('{{ needs.check.outputs.sha }}') });
  expect(caller?.needs).toEqual(['check', 'quality']);
  expect(caller?.with?.generate_notes).toBe(true);
  expect(ci.jobs?.checks?.if).toBe('$'.concat('{{ !inputs.nightly }}'));
  expect(ci.jobs?.['dist-tail']?.if).toBe('$'.concat('{{ !inputs.release_validation && !inputs.nightly }}'));
  expect(ci.jobs?.['e2e-deps']?.if).not.toContain('inputs.nightly');
  expect(gate).toContain('if [[ "$NIGHTLY" == true ]]');
  expect(gate).toContain('test "$INTEGRATION_RESULT" = success');
  expect(nightly.jobs?.['live-e2e']).toBeUndefined();
  expect(nightly.jobs?.['installer-arm64']).toBeUndefined();
  expect(step(release, 'publish', 'Generate nightly release notes')?.uses).toContain('git-cliff-action@');
  expect(releaseSmoke.jobs?.['windows-arm64']?.if).toContain("workflow_run.conclusion == 'success'");
  expect(step(releaseSmoke, 'windows-arm64', 'Test PowerShell installer')?.run).toContain('Checksum verified');
});
