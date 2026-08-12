#!/usr/bin/env bun
/**
 * Build the monad release: ONE self-contained Bun binary per platform.
 *
 * Pipeline:
 *   1. bun install
 *   2. Web: build the Vite SPA (apps/web/out/) → generate the embed module
 *   3. Compile apps/cli/src/bin.ts → bin/monad (embeds daemon + web + tui + SPA)
 *   4. tar archive per platform
 *
 * Usage:
 *   bun run scripts/build-release.ts                                   # host platform only (glibc)
 *   bun run scripts/build-release.ts --musl                            # host arch, musl libc (Alpine/embedded)
 *   bun run scripts/build-release.ts --all                             # darwin/linux/windows × arm64/x64, + linux musl
 *   bun run scripts/build-release.ts --target=aarch64-apple-darwin      # one dist/Rust target triple
 *   bun run scripts/build-release.ts --version=0.2.0-beta.1             # embed an exact release version
 *   bun run scripts/build-release.ts --build=abc1234                   # append build metadata to version (+abc1234)
 *   bun run scripts/build-release.ts --prerelease=nightly.20260617     # pre-release channel identifier (-nightly.20260617)
 *   bun run scripts/build-release.ts --all --prerelease=nightly.20260617 --build=abc1234
 *
 * Output: dist/monad-{version}-{os}-{arch}.tar.gz
 */

import type { BunPlugin } from 'bun';

import { copyFileSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { $, Glob } from 'bun';

import monadPkg from '../apps/monad/package.json' with { type: 'json' };
import { generateMigrationAssets } from '../apps/monad/scripts/generate-migration-assets.ts';
import rootPkg from '../package.json' with { type: 'json' };
import { MONAD_PROCESS_ROLES } from '../packages/environment/src/process-name.ts';
import { buildMacOSNotificationApp } from './lib/macos-notification-app.ts';
import { createPlatformModulePlugin } from './lib/platform-modules.ts';
import { optionalPeerExternals } from './lib/release-optional-peers.ts';
import { releasePlatformModuleRules } from './lib/release-platform-modules.ts';
import { distTargetFromReleaseTarget, type ReleaseTarget, releaseTargetFromDistTarget } from './lib/release-target.ts';

const ROOT = resolve(import.meta.dir, '..');
const DIST = join(ROOT, 'dist');
const { values: cli } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    all: { type: 'boolean' },
    build: { type: 'string' },
    musl: { type: 'boolean' },
    'no-archive': { type: 'boolean' },
    os: { type: 'string' },
    prerelease: { type: 'string' },
    target: { type: 'string' },
    version: { type: 'string' }
  },
  strict: true
});
const buildArg = cli.build;
// --prerelease=nightly.20260617 → appends a pre-release identifier (SemVer §9) before the build hash.
// Stable:  0.0.1
// Beta:    0.0.1-beta.1   (set by release-please, not this script)
// Nightly: 0.0.1-nightly.20260617+abc1234
const prereleaseArg = cli.prerelease;
if (cli.version && (prereleaseArg || buildArg)) {
  throw new Error('--version cannot be combined with --prerelease or --build');
}
const VERSION =
  cli.version ?? [rootPkg.version, prereleaseArg ? `-${prereleaseArg}` : '', buildArg ? `+${buildArg}` : ''].join('');
const BUILD_ALL = cli.all ?? false;
if (BUILD_ALL && cli.target) throw new Error('--all and --target are mutually exclusive');

// `libc` only applies to linux: glibc (default, broad desktop/server distros) vs musl (Alpine and
// most embedded/Buildroot rootfs). Bun ships distinct compile targets per libc; a glibc binary
// will not run on a musl-only system and vice versa, so embedded Linux needs its own musl artifact.
type Target = ReleaseTarget;

/** `linux-arm64-musl` etc. — the suffix shared by Bun's compile target and our artifact name. */
function triple(t: Target): string {
  return `${t.os}-${t.arch}${t.libc ? `-${t.libc}` : ''}`;
}

const HOST: Target = {
  os: process.platform === 'darwin' ? 'darwin' : 'linux',
  arch: process.arch === 'arm64' ? 'arm64' : 'x64',
  // A host build on Alpine/musl wants a musl binary; pass --musl (or set when the rootfs is musl).
  ...(process.platform === 'linux' && cli.musl ? { libc: 'musl' as const } : {})
};
if (process.platform !== 'darwin' && process.platform !== 'linux') {
  process.stderr.write('Build script must run on darwin or linux (cross-compiles to windows).\n');
  process.exit(1);
}
// --os=darwin (or --os=linux,windows) restricts the build to those OSes. The release runs the
// build matrix split by OS — darwin on a macOS runner (Cocoa can't cross-compile), linux+windows
// cross-compiled on Linux — so each runner emits only its slice.
const osArg = cli.os;
const osFilter = osArg ? new Set(osArg.split(',')) : null;

const TARGETS: Target[] = (
  cli.target
    ? [releaseTargetFromDistTarget(cli.target)]
    : BUILD_ALL
      ? ([
          { os: 'darwin', arch: 'arm64' },
          { os: 'darwin', arch: 'x64' },
          { os: 'linux', arch: 'arm64' },
          { os: 'linux', arch: 'x64' },
          { os: 'linux', arch: 'arm64', libc: 'musl' }, // embedded Linux / Alpine (ARM SBCs)
          { os: 'linux', arch: 'x64', libc: 'musl' }, // embedded Linux / Alpine (x64)
          { os: 'windows', arch: 'x64' },
          { os: 'windows', arch: 'arm64' }
        ] satisfies Target[])
      : [HOST]
).filter((t) => !osFilter || osFilter.has(t.os));

// Ink statically imports react-devtools-core (an optional, uninstalled dev-only dep). Stub it so
// the binary is fully self-contained — devtools is never used outside Ink's DEV bridge.
const stubReactDevtools: BunPlugin = {
  name: 'stub-react-devtools-core',
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: 'react-devtools-core', namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export default {}; export function connectToDevTools(){}',
      loader: 'js'
    }));
  }
};

const stubBetterSqlite3: BunPlugin = {
  name: 'stub-better-sqlite3',
  setup(build) {
    build.onResolve({ filter: /^better-sqlite3$/ }, () => ({ path: 'better-sqlite3', namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents:
        'export default class BetterSqlite3 { constructor(){ throw new Error("better-sqlite3 is unavailable in the self-contained release"); } }',
      loader: 'js'
    }));
  }
};

log(`Building monad ${VERSION} for: ${TARGETS.map((t) => `${t.os}-${t.arch}`).join(', ')}`);

// ── 0. Install workspace deps ─────────────────────────────────────────────────
log('Installing workspace dependencies…');
await $`bun install`.cwd(ROOT);
const optionalExternals = await optionalPeerExternals(
  join(ROOT, 'apps/monad/node_modules/mem0ai/package.json'),
  Object.keys(monadPkg.dependencies ?? {})
);
// Covers gen-config-schema, generate-licenses, the codex/avatar generators, the web route tree,
// and the i18n types — all gitignored, so a fresh clone has none of them and the bundle can't resolve.
await $`bun run generate`.cwd(ROOT);
generateMigrationAssets();
// ── 1. Web: static build (platform-independent; done once) ───────────────────
log('Building apps/web static assets…');
await $`bun run build`.cwd(join(ROOT, 'apps/web')).env({ ...Bun.env, NODE_ENV: 'production' });
if (!existsSync(join(ROOT, 'apps/web/out/index.html'))) {
  process.stderr.write('web build did not produce apps/web/out/index.html\n');
  process.exit(1);
}

// Compress static-export files and embed only the gzip copies. Bun stores embedded asset names with
// their source path tail, so the web server strips apps/web/out.gz/ and the trailing .gz at runtime.
const webOutDir = join(ROOT, 'apps/web/out');
const webOutGzipDir = join(ROOT, 'apps/web/out.gz');
const webFiles: string[] = [];
const webLoader: Record<string, 'file'> = { '.gz': 'file' };
if (existsSync(webOutGzipDir)) rmSync(webOutGzipDir, { recursive: true });
for await (const rel of new Glob('**/*').scan({ cwd: webOutDir, onlyFiles: true, dot: true })) {
  const abs = join(webOutDir, rel);
  const out = join(webOutGzipDir, `${rel}.gz`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Bun.gzipSync(new Uint8Array(await Bun.file(abs).arrayBuffer())));
  webFiles.push(out);
}
if (!existsSync(join(webOutGzipDir, 'index.html.gz'))) {
  process.stderr.write('web gzip embed did not produce apps/web/out.gz/index.html.gz\n');
  process.exit(1);
}

try {
  // ── 2. Compile one binary per target ─────────────────────────────────────────
  for (const t of TARGETS) {
    const artifact = `monad-${VERSION}-${triple(t)}`;
    const artifactDir = join(DIST, artifact);
    const binDir = join(artifactDir, 'bin');
    const assetsDir = join(artifactDir, 'assets');
    if (existsSync(artifactDir)) rmSync(artifactDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    mkdirSync(assetsDir, { recursive: true });
    copyFileSync(
      join(ROOT, 'apps/web/public/monad-icon-vector-solid.svg'),
      join(assetsDir, 'monad-icon-vector-solid.svg')
    );
    copyFileSync(join(ROOT, 'apps/web/public/favicon.ico'), join(assetsDir, 'favicon.ico'));
    copyFileSync(join(ROOT, 'apps/web/public/monad-icon-1024.png'), join(assetsDir, 'monad-icon-1024.png'));

    if (t.os === 'darwin') {
      await buildMacOSNotificationApp({ root: ROOT, artifactDir, arch: t.arch });
      log('  ✓ native Monad notification app');
    }

    const isWindows = t.os === 'windows';
    const binName = isWindows ? 'monad.exe' : 'monad';

    // ── 2a. Compile native sandbox launchers ────────────────────────────────────
    // Ship alongside bin/monad as bin/monad-sandbox-launcher[.exe] (Low IL / Landlock)
    // and bin/monad-sandbox-appcontainer.exe (AppContainer, Windows-only, preferred).
    // These helpers are required release artifacts. Fail with the compiler diagnostic instead of
    // producing an incomplete runtime that dist will reject later.
    if (t.os === 'linux') {
      const launcherSrc = join(ROOT, 'apps/monad/native/sandbox-launcher/main.c');
      const launcherOut = join(binDir, 'monad-sandbox-launcher');
      // The launcher is a standalone static ELF, so its libc does not need to match the embedded
      // Bun binary. Ubuntu's musl-gcc sysroot omits Linux UAPI headers required by Landlock/seccomp.
      const cc = t.arch === 'arm64' ? 'aarch64-linux-gnu-gcc' : 'gcc';
      const r = await $`${cc} -O2 -s -static -o ${launcherOut} ${launcherSrc}`.nothrow().quiet();
      if (r.exitCode !== 0) {
        throw new Error(`${artifact} sandbox launcher failed to compile with ${cc}: ${shellDiagnostic(r)}`);
      }
      log(`  ✓ sandbox launcher (${cc})`);
    }
    if (t.os === 'windows') {
      const cc =
        t.arch === 'arm64'
          ? 'aarch64-w64-mingw32-clang' // llvm-mingw provides this; not in Ubuntu apt
          : 'x86_64-w64-mingw32-gcc';
      const staticFlag = t.arch === 'arm64' ? [] : ['-static']; // llvm-mingw links dynamically

      // Low Integrity launcher (monad-sandbox-launcher.exe) — fallback when AppContainer is unavailable
      const lowILSrc = join(ROOT, 'apps/monad/native/sandbox-launcher/windows.c');
      const lowILOut = join(binDir, 'monad-sandbox-launcher.exe');
      const lowILFlags = ['-O2', '-s', ...staticFlag, '-municode', '-o', lowILOut, lowILSrc, '-ladvapi32'];
      const rLowIL = await $`${cc} ${lowILFlags}`.nothrow().quiet();
      if (rLowIL.exitCode !== 0) {
        log(`  ⚠ ${cc} not found — ${artifact} Low IL sandbox launcher omitted`);
      } else {
        log(`  ✓ sandbox launcher / Low IL (${cc})`);
      }

      // AppContainer launcher (monad-sandbox-appcontainer.exe) — preferred over Low IL
      const acSrc = join(ROOT, 'apps/monad/native/sandbox-launcher/windows-appcontainer.c');
      const acOut = join(binDir, 'monad-sandbox-appcontainer.exe');
      const acFlags = ['-O2', '-s', ...staticFlag, '-municode', '-o', acOut, acSrc, '-ladvapi32', '-luserenv'];
      const rAC = await $`${cc} ${acFlags}`.nothrow().quiet();
      if (rAC.exitCode !== 0) {
        log(`  ⚠ ${artifact} AppContainer launcher omitted (Low IL fallback remains)`);
      } else {
        log(`  ✓ sandbox launcher / AppContainer (${cc})`);
      }

      // Assign the stable Monad AppUserModelID to the installed Start Menu shortcut. Windows desktop
      // toasts require a shortcut carrying the same ID passed to CreateToastNotifier.
      const aumidSrc = join(ROOT, 'apps/monad/native/windows-shortcut-aumid/main.c');
      const aumidOut = join(binDir, 'monad-shortcut-aumid.exe');
      const aumidFlags = ['-O2', '-s', ...staticFlag, '-municode', '-o', aumidOut, aumidSrc, '-lole32', '-luuid'];
      const rAumid = await $`${cc} ${aumidFlags}`.nothrow().quiet();
      if (rAumid.exitCode !== 0) {
        throw new Error(`${artifact} AppUserModelID helper failed to compile with ${cc}: ${shellDiagnostic(rAumid)}`);
      }
      log(`  ✓ Windows AppUserModelID helper (${cc})`);
    }

    log(`Compiling ${artifact} (bun-${triple(t)})…`);
    const platformModules = createPlatformModulePlugin({
      platform: t.os,
      rules: releasePlatformModuleRules(ROOT)
    });
    const res = await Bun.build({
      entrypoints: [join(ROOT, 'apps/cli/src/bin.ts'), ...webFiles],
      external: optionalExternals,
      compile: {
        target: `bun-${t.os}-${t.arch}${t.libc ? `-${t.libc}` : ''}` as Bun.Build.CompileTarget,
        outfile: join(binDir, binName)
      },
      // Assets keep clean paths; entry wrappers get hashes to prevent name collisions when two
      // web files share the same basename (e.g. _not-found.html + _not-found.txt → _not-found.js).
      naming: { entry: '[dir]/[name]-[hash].[ext]', asset: '[dir]/[name].[ext]' },
      loader: webLoader,
      minify: true,
      plugins: [stubReactDevtools, stubBetterSqlite3, platformModules.plugin],
      define: {
        BUILD_VERSION: JSON.stringify(VERSION),
        BUILD_DIST_TARGET: JSON.stringify(distTargetFromReleaseTarget(t)),
        'Bun.env.NODE_ENV': JSON.stringify('production')
      }
    });
    if (!res.success) {
      for (const l of res.logs) process.stderr.write(`${l.message}\n`);
      throw new Error(`compile failed for ${artifact}`);
    }
    platformModules.assertResolved();

    // ── 2a½. Role-named siblings for process naming ───────────────────────────────
    // `ps`/Activity Monitor/Task Manager name a process after the executed file itself, not argv or
    // process.title — so the daemon, its restart supervisor, and its child-process watchdog (which
    // all self-exec this same binary) get symlinked aliases here. roleExecPath() picks the matching
    // alias at spawn time, falling back to bin/monad when one is missing (dev, or an older install).
    // No unprivileged same-volume symlink exists on Windows, so it ships without aliases there —
    // those roles still spawn, just all displayed as monad.exe.
    if (!isWindows) {
      for (const role of MONAD_PROCESS_ROLES) {
        symlinkSync(binName, join(binDir, `monad-${role}`));
      }
      log(`  ✓ process-name aliases (${MONAD_PROCESS_ROLES.map((r) => `monad-${r}`).join(', ')})`);
    }

    // ── 3. tar archive ─────────────────────────────────────────────────────────
    if (!cli['no-archive']) {
      const tarball = `${artifact}.tar.gz`;
      await $`tar -czf ${join(DIST, tarball)} -C ${DIST} ${artifact}`;
      log(`  ✓ dist/${tarball}`);
    }
  }
} finally {
  if (existsSync(webOutGzipDir)) rmSync(webOutGzipDir, { recursive: true });
}

const hostArtifact = `monad-${VERSION}-${HOST.os}-${HOST.arch}`;
process.stdout.write(`
Done. Verify the host binary directly:
  ./dist/${hostArtifact}/bin/monad --help
  ./dist/${hostArtifact}/bin/monad up        # daemon + web together

Production archives, installers, updater binaries, and receipts are generated and tested by dist.
`);

function log(msg: string) {
  process.stdout.write(`[build-release] ${msg}\n`);
}

function shellDiagnostic(result: { stderr: Uint8Array; stdout: Uint8Array }): string {
  return (
    new TextDecoder().decode(result.stderr).trim() || new TextDecoder().decode(result.stdout).trim() || 'no output'
  );
}
