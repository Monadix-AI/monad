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
  needs?: string[];
  permissions?: Record<string, string>;
  strategy?: { matrix?: { include?: Array<Record<string, string>> } };
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
  const llvmMingw = namedStep('build', 'Install LLVM MinGW for Windows ARM64');
  const generate = namedStep('installers', 'Generate shell and PowerShell installers')?.run;
  const installerBun = jobs.installers?.steps?.find((step) => step.uses?.startsWith('oven-sh/setup-bun@'));
  const upload = jobs.installers?.steps?.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
  const shellTest = namedStep('install-test', 'Test shell installer and updater receipt')?.run;
  const powerShellTest = namedStep('install-test', 'Test PowerShell installer and updater receipt')?.run;
  const attest = namedStep('publish', 'Attest release assets');
  const stageAssets = namedStep('publish', 'Stage public release assets')?.run;
  const changelog = namedStep('publish', 'Generate complete release changelog')?.run;
  const releaseUpload = namedStep('publish', 'Upload release assets');
  const localDeploy = await Bun.file(join(root, 'scripts/deploy-local-dist.ts')).text();
  const upgradeE2e = await Bun.file(join(root, 'scripts/test/upgrade-dist-e2e.ts')).text();
  const distWorkspace = await Bun.file(join(root, 'dist-workspace.toml')).text();
  const distPackage = await Bun.file(join(root, 'distribution/dist.toml')).text();
  const buildMatrix = jobs.build?.strategy?.matrix?.include ?? [];
  const installMatrix = jobs['install-test']?.strategy?.matrix?.include ?? [];

  expect(build).toContain('--artifacts=local');
  expect(build).toContain('dist-manifest.json');
  expect(crossCompilers).toContain('binutils-aarch64-linux-gnu');
  expect(crossCompilers).toContain('libc6-dev-arm64-cross');
  expect(crossCompilers).not.toContain('musl-tools');
  expect(buildMatrix).toContainEqual({ runner: 'ubuntu-latest', target: 'aarch64-pc-windows-msvc' });
  expect(llvmMingw?.if).toBe("matrix.target == 'aarch64-pc-windows-msvc'");
  expect(llvmMingw?.run).toContain('aarch64-w64-mingw32-clang');
  expect(llvmMingw?.run).toContain('sha256sum --check');
  expect(installMatrix).toContainEqual({ os: 'windows-arm64', runner: 'windows-11-arm' });
  expect(distWorkspace).toContain('"aarch64-pc-windows-msvc"');
  expect(distPackage).toContain('aarch64-pc-windows-msvc = [');
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
  expect(namedStep('publish', 'Publish release')?.run).toContain(`--repo "\${GITHUB_REPOSITORY}"`);
  expect(changelog).toContain('scripts/generate-release-changelog.ts');
  expect(changelog).toContain(`--target "\${RELEASE_REF}"`);
  expect(releaseUpload?.with?.body_path).toBe('release-notes.md');
  expect(releaseUpload?.with?.generate_release_notes).toBeUndefined();
  expect(stageAssets).toBe('bun scripts/stage-public-release-assets.ts --from artifacts --to release-assets');
  expect(upgradeE2e).toContain('readdirSync(newDir');
  expect(upgradeE2e).toContain('browser_download_url: assetUrl');
  expect(upgradeE2e).toContain("await run([monad, 'up'], env)");
  expect(attest?.uses).toMatch(/^actions\/attest@[0-9a-f]{40}$/);
  expect(attest?.with?.['subject-path']).toBe('release-assets/*');
  expect(releaseUpload?.with?.files).toBe('release-assets/*');
  expect(jobs.publish?.permissions).toMatchObject({ attestations: 'write', 'id-token': 'write' });
  expect(releasePlease.jobs?.['release-assets']?.permissions).toMatchObject({
    attestations: 'write',
    'id-token': 'write'
  });
});
