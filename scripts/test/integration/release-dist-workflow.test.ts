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
  env?: Record<string, string>;
  if?: string;
  needs?: string[];
  permissions?: Record<string, string>;
  'runs-on'?: string;
  strategy?: { matrix?: { include?: Array<Record<string, string>> } };
  steps?: Step[];
  'timeout-minutes'?: number;
}

const root = resolve(import.meta.dir, '../../..');
const workflow = Bun.YAML.parse(await Bun.file(join(root, '.github/workflows/release.yml')).text()) as {
  jobs?: Record<string, Job>;
};
const releasePlease = Bun.YAML.parse(await Bun.file(join(root, '.github/workflows/release-please.yml')).text()) as {
  jobs?: Record<string, Job>;
};
const atomPackRelease = Bun.YAML.parse(
  await Bun.file(join(root, '.github/workflows/atom-pack-release.yml')).text()
) as {
  jobs?: Record<string, Job>;
};
const nightly = Bun.YAML.parse(await Bun.file(join(root, '.github/workflows/nightly.yml')).text()) as {
  jobs?: Record<string, Job>;
};
const ci = Bun.YAML.parse(await Bun.file(join(root, '.github/workflows/ci.yml')).text()) as {
  jobs?: Record<string, Job>;
};
const releaseEnv =
  (
    Bun.YAML.parse(await Bun.file(join(root, '.github/workflows/release.yml')).text()) as {
      env?: Record<string, string>;
    }
  ).env ?? {};
const jobs = workflow.jobs ?? {};
const namedStep = (job: string, name: string) => jobs[job]?.steps?.find((step) => step.name === name);
const namedCiStep = (job: string, name: string) => ci.jobs?.[job]?.steps?.find((step) => step.name === name);
const namedNightlyStep = (job: string, name: string) => nightly.jobs?.[job]?.steps?.find((step) => step.name === name);

test('release workflow builds, exercises, attests, and publishes dist installers', async () => {
  const build = namedStep('build', 'Build target archive')?.run;
  const crossCompilers = namedStep('build', 'Install Linux and Windows cross-compilers')?.run;
  const llvmMingw = namedStep('build', 'Install LLVM MinGW for Windows ARM64');
  const generate = namedStep('installers', 'Generate shell and PowerShell installers')?.run;
  const installerBun = jobs.installers?.steps?.find((step) => step.uses?.startsWith('oven-sh/setup-bun@'));
  const upload = jobs.installers?.steps?.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
  const shellTest = namedStep('install-test', 'Test shell installer')?.run;
  const powerShellTest = namedStep('install-test', 'Test PowerShell installer')?.run;
  const attest = namedStep('publish', 'Attest release assets');
  const stageAssets = namedStep('publish', 'Stage public release assets')?.run;
  const changelog = namedStep('publish', 'Generate complete release changelog')?.run;
  const releaseUpload = namedStep('publish', 'Upload release assets');
  const digestVerification = namedStep('publish', 'Verify GitHub release asset digests')?.run;
  const localDeploy = await Bun.file(join(root, 'scripts/deploy-local-dist.ts')).text();
  const localDeployPlatform = await Bun.file(join(root, 'scripts/lib/local-dist-platform.ts')).text();
  const releaseBuilder = await Bun.file(join(root, 'scripts/build-release.ts')).text();
  const upgradeE2e = await Bun.file(join(root, 'scripts/test/upgrade-dist-e2e.ts')).text();
  const distWorkspace = await Bun.file(join(root, 'dist-workspace.toml')).text();
  const distPackage = await Bun.file(join(root, 'dist.toml')).text();
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
  // behavior-ok: moving the ARM smoke off the release path preserves nightly compatibility coverage
  expect({
    releaseInstallers: installMatrix,
    releaseArmJob: jobs['install-test-arm64'] ?? null,
    nightlyArmJob: {
      distVersion: nightly.jobs?.['installer-arm64']?.env?.MONAD_DIST_VERSION,
      needs: nightly.jobs?.['installer-arm64']?.needs,
      runsOn: nightly.jobs?.['installer-arm64']?.['runs-on'],
      verifiesChecksum: namedNightlyStep('installer-arm64', 'Test PowerShell installer')?.run?.includes(
        'Checksum verified'
      )
    }
  }).toEqual({
    releaseInstallers: [
      { os: 'linux', runner: 'ubuntu-latest' },
      { os: 'macos', runner: 'macos-14' },
      { os: 'windows', runner: 'windows-latest' }
    ],
    releaseArmJob: null,
    nightlyArmJob: {
      distVersion: '$'.concat('{{ needs.check.outputs.tag }}'),
      needs: ['check', 'release-assets'],
      runsOn: 'windows-11-arm',
      verifiesChecksum: true
    }
  });
  expect(jobs['install-test']?.['timeout-minutes']).toBe(10);
  expect(distWorkspace).toContain('"aarch64-pc-windows-msvc"');
  expect(distWorkspace).toContain('install-updater = false');
  expect(distPackage).toContain('aarch64-pc-windows-msvc = [');
  expect(installerBun?.with?.['bun-version']).toBe('1.3.14');
  expect(generate).toContain('--artifacts=global');
  expect(generate).toContain('bun scripts/enhance-dist-installers.ts');
  expect(upload?.with?.path).toContain('target/distrib/install.sh');
  expect(upload?.with?.path).toContain('target/distrib/install.ps1');
  expect(shellTest).toContain('script -qefc "sh artifacts/install.sh"');
  expect(shellTest).toContain('MONAD_NO_OPEN=1');
  expect(shellTest).toContain('MONAD_FORCE_INTERACTIVE=1');
  expect(shellTest).toContain('Checksum verified');
  expect(shellTest).toContain('no checksums to verify');
  expect(shellTest).toContain('skipping sha256 checksum verification');
  expect(powerShellTest).toContain('MONAD_FORCE_INTERACTIVE');
  expect(powerShellTest).toContain("MONAD_NO_OPEN = '1'");
  expect(powerShellTest).toContain('Checksum verified');
  expect(powerShellTest).toContain('no checksums to verify');
  expect(localDeploy).toContain('localInstallPlan(');
  expect(localDeployPlatform).toContain("posix.join(artifactsDir, 'install.sh')");
  expect(localDeployPlatform).toContain("win32.join(artifactsDir, 'install.ps1')");
  expect(localDeployPlatform).toContain("win32.join(installDir, 'monad.exe')");
  expect(localDeployPlatform).toContain("'powershell.exe'");
  expect(releaseBuilder).toContain("process.platform === 'win32' ? 'windows'");
  expect(releaseBuilder).toContain("label: 'MSVC cl.exe'");

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
  expect(upgradeE2e).toContain('immutable: true');
  expect(upgradeE2e).toContain("new Bun.CryptoHasher('sha256').update(bytes).digest('hex')");
  expect(upgradeE2e).toContain('size: bytes.byteLength');
  expect(upgradeE2e).toContain("await run([monad, 'up'], env)");
  expect(attest?.uses).toMatch(/^actions\/attest@[0-9a-f]{40}$/);
  expect(attest?.with?.['subject-path']).toBe('release-assets/*');
  expect(releaseUpload?.with?.files).toBe('release-assets/*');
  expect(digestVerification).toContain('gh release view');
  expect(digestVerification).toContain('.assets[] | select(.name == $name) | .digest');
  expect(digestVerification).toContain('sha256sum "'.concat('$', '{asset}"'));
  expect(jobs.publish?.permissions).toMatchObject({ attestations: 'write', 'id-token': 'write' });
  expect(releasePlease.jobs?.['release-assets']?.permissions).toMatchObject({
    attestations: 'write',
    'id-token': 'write'
  });
});

test('publishing establishes its repository and asset contract before mutating the release', () => {
  const steps = jobs.publish?.steps ?? [];
  const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  const order = [
    'Stage public release assets',
    'Attest release assets',
    'Generate complete release changelog',
    'Upload release assets',
    'Verify GitHub release asset digests',
    'Publish release'
  ].map((name) => steps.findIndex((step) => step.name === name));

  // behavior-ok: parsing the publish job verifies its repository checkout and fail-closed release mutation order
  expect({
    checkout: {
      fetchDepth: checkout?.with?.['fetch-depth'],
      persistsCredentials: checkout?.with?.['persist-credentials'],
      ref: checkout?.with?.ref
    },
    failClosedUpload: namedStep('publish', 'Upload release assets')?.with?.fail_on_unmatched_files,
    orderedBeforePublication: order.every(
      (index, position) => index >= 0 && (position === 0 || (order[position - 1] ?? -1) < index)
    )
  }).toEqual({
    checkout: {
      fetchDepth: 0,
      persistsCredentials: false,
      ref: '$'.concat('{{ env.RELEASE_REF }}')
    },
    failClosedUpload: true,
    orderedBeforePublication: true
  });
});

test('every caller of release.yml grants the permissions its publish job declares', () => {
  const declared = jobs.publish?.permissions ?? {};
  const callers = {
    nightly: nightly.jobs?.['release-assets']?.permissions ?? {},
    'release-please': releasePlease.jobs?.['release-assets']?.permissions ?? {}
  };

  // A called workflow cannot escalate past its caller's grant; GitHub rejects a shortfall before scheduling jobs.
  expect(
    Object.fromEntries(
      Object.entries(callers).map(([caller, granted]) => [
        caller,
        Object.keys(declared).filter((scope) => granted[scope] !== declared[scope])
      ])
    )
  ).toEqual({ nightly: [], 'release-please': [] });
});

test('the installer and upgrade path is gated before main, not only during a release', () => {
  const distTail = ci.jobs?.['dist-tail'];
  const gateStep = ci.jobs?.gate?.steps?.find((step) => step.name === 'Verify required jobs');
  const releaseInstallCommands = ['build', 'installers', 'upgrade-test'].map(
    (job) => namedStep(job, 'Install dist')?.run
  );
  const ciInstallCommand = namedCiStep('dist-tail', 'Install dist')?.run;

  // The explicit input covers pull requests and merge queues while release.yml supplies real artifact coverage.
  expect({
    skipsOnlyReleaseValidation: distTail?.if,
    exercisesUpgrade: namedCiStep('dist-tail', 'Upgrade an active daemon through CLI and Web')?.run?.includes(
      'scripts/test/upgrade-dist-e2e.ts'
    ),
    exercisesInstaller: namedCiStep('dist-tail', 'Test shell installer')?.run?.includes('Checksum verified'),
    requiredByGate: gateStep?.run?.includes('test "$DIST_TAIL_RESULT" = success'),
    distVersionMatchesRelease: distTail?.env?.DIST_VERSION === releaseEnv.DIST_VERSION,
    installerPinMatchesRelease: distTail?.env?.DIST_INSTALLER_SHA256 === releaseEnv.DIST_INSTALLER_SHA256,
    installCommands: [...releaseInstallCommands, ciInstallCommand]
  }).toEqual({
    // Covers pull_request and merge_group alike; gating on either alone would be dead code today or
    // a silently dropped gate once a merge queue is enabled.
    skipsOnlyReleaseValidation: '$'.concat('{{ !inputs.release_validation }}'),
    exercisesUpgrade: true,
    exercisesInstaller: true,
    requiredByGate: true,
    distVersionMatchesRelease: true,
    installerPinMatchesRelease: true,
    installCommands: Array.from(
      { length: 4 },
      () => 'bun scripts/install-cargo-dist.ts "$DIST_VERSION" "$DIST_INSTALLER_SHA256"'
    )
  });
});

test('an unknown upgrade scenario is rejected rather than silently skipped', async () => {
  const script = join(root, 'scripts/test/upgrade-dist-e2e.ts');
  const proc = Bun.spawn(['bun', script, '--old-dir', '.', '--new-dir', '.', '--tag', 'v0.0.2', '--scenario', 'tui'], {
    stderr: 'pipe',
    stdout: 'pipe'
  });
  const stderr = await new Response(proc.stderr).text();

  expect({ exitCode: await proc.exited, namesTheBadValue: stderr.includes('unknown --scenario tui') }).toEqual({
    exitCode: 1,
    namesTheBadValue: true
  });
});

test('GitHub releases publish canonical assets without checksum sidecars', () => {
  const powerPackUpload = jobs['atom-pack']?.steps?.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
  const reusableRelease = atomPackRelease.jobs?.release?.steps?.find((step) =>
    step.uses?.startsWith('softprops/action-gh-release@')
  );

  expect({
    powerPackArtifact: powerPackUpload?.with?.path,
    reusableReleaseAssets: reusableRelease?.with?.files
  }).toEqual({
    powerPackArtifact: 'dist/monad-power-pack.atom-pack.zip',
    reusableReleaseAssets: 'release/atom-pack.zip'
  });
});
