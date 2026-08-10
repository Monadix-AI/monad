import { expect, test } from 'bun:test';
import { join, resolve } from 'node:path';

interface Step {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface Job {
  needs?: string[];
  permissions?: Record<string, string>;
  steps?: Step[];
}

const root = resolve(import.meta.dir, '../../..');
const workflow = Bun.YAML.parse(await Bun.file(join(root, '.github/workflows/release.yml')).text()) as {
  jobs?: Record<string, Job>;
};
const releasePlease = Bun.YAML.parse(await Bun.file(join(root, '.github/workflows/release-please.yml')).text()) as {
  jobs?: Record<string, Job>;
};
const jobs = workflow.jobs ?? {};
const namedStep = (job: string, name: string) => jobs[job]?.steps?.find((step) => step.name === name);

test('release workflow builds, exercises, attests, and publishes dist installers', async () => {
  const build = namedStep('build', 'Build target archive and updater')?.run;
  const crossCompilers = namedStep('build', 'Install Linux and Windows cross-compilers')?.run;
  const generate = namedStep('installers', 'Generate shell and PowerShell installers')?.run;
  const installerBun = jobs.installers?.steps?.find((step) => step.uses?.startsWith('oven-sh/setup-bun@'));
  const upload = jobs.installers?.steps?.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
  const shellTest = namedStep('install-test', 'Test shell installer and updater receipt')?.run;
  const powerShellTest = namedStep('install-test', 'Test PowerShell installer and updater receipt')?.run;
  const attest = namedStep('publish', 'Attest release assets');
  const localDeploy = await Bun.file(join(root, 'scripts/deploy-local-dist.ts')).text();
  const upgradeE2e = await Bun.file(join(root, 'scripts/test/upgrade-dist-e2e.ts')).text();

  expect(build).toContain('--artifacts=local');
  expect(build).toContain('dist-manifest.json');
  expect(crossCompilers).toContain('binutils-aarch64-linux-gnu');
  expect(crossCompilers).toContain('libc6-dev-arm64-cross');
  expect(crossCompilers).not.toContain('musl-tools');
  expect(installerBun?.with?.['bun-version']).toBe('1.3.14');
  expect(generate).toContain('--artifacts=global');
  expect(generate).toContain('bun scripts/enhance-dist-installers.ts');
  expect(upload?.with?.path).toContain('target/distrib/install.sh');
  expect(upload?.with?.path).toContain('target/distrib/install.ps1');
  expect(upload?.with?.path).toContain('target/distrib/monad-installer.sh');
  expect(upload?.with?.path).toContain('target/distrib/monad-installer.ps1');
  expect(shellTest).toContain('script -qefc "sh artifacts/install.sh"');
  expect(shellTest).toContain('MONAD_FORCE_INTERACTIVE=1');
  expect(shellTest).toContain('no checksums to verify');
  expect(shellTest).toContain('skipping sha256 checksum verification');
  expect(powerShellTest).toContain('MONAD_FORCE_INTERACTIVE');
  expect(powerShellTest).toContain('no checksums to verify');
  expect(localDeploy).toContain("join(artifactsDir, 'install.sh')");

  expect(jobs.publish?.needs).toEqual(['atom-pack', 'install-test', 'upgrade-test']);
  expect(namedStep('upgrade-test', 'Upgrade an active daemon through CLI and Web')?.run).toContain(
    'scripts/test/upgrade-dist-e2e.ts'
  );
  expect(namedStep('upgrade-test', 'Install dependencies')?.run).toBe('bun install --frozen-lockfile');
  expect(upgradeE2e).toContain('readdirSync(newDir');
  expect(upgradeE2e).toContain('browser_download_url: assetUrl');
  expect(upgradeE2e).toContain("await run([monad, 'up'], env)");
  expect(attest?.uses).toMatch(/^actions\/attest@[0-9a-f]{40}$/);
  expect(attest?.with?.['subject-path']).toBe('artifacts/*');
  expect(jobs.publish?.permissions).toMatchObject({ attestations: 'write', 'id-token': 'write' });
  expect(releasePlease.jobs?.['release-assets']?.permissions).toMatchObject({
    attestations: 'write',
    'id-token': 'write'
  });
});
