#!/usr/bin/env bun
/**
 * Build the monad release: ONE self-contained Bun binary per platform.
 *
 * Pipeline:
 *   1. bun install
 *   2. Web: static-export the Next SPA (apps/web/out/) → generate the embed module
 *   3. Compile apps/cli/src/bin.ts → bin/monad (embeds daemon + web + tui + SPA)
 *   4. tar + sha256 per platform
 *
 * Usage:
 *   bun run scripts/build-release.ts                                   # host platform only (glibc)
 *   bun run scripts/build-release.ts --musl                            # host arch, musl libc (Alpine/embedded)
 *   bun run scripts/build-release.ts --all                             # darwin/linux × arm64/x64, + linux musl, + windows-x64
 *   bun run scripts/build-release.ts --build=abc1234                   # append build metadata to version (+abc1234)
 *   bun run scripts/build-release.ts --prerelease=nightly.20260617     # pre-release channel identifier (-nightly.20260617)
 *   bun run scripts/build-release.ts --all --prerelease=nightly.20260617 --build=abc1234
 *
 * Output: dist/monad-{version}-{os}-{arch}.tar.gz (+ .sha256)
 */

import type { BunPlugin } from 'bun';

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { $, Glob } from 'bun';

import rootPkg from '../package.json' with { type: 'json' };

const ROOT = resolve(import.meta.dir, '..');
const DIST = join(ROOT, 'dist');
const buildArg = process.argv.find((a) => a.startsWith('--build='))?.slice('--build='.length);
// --prerelease=nightly.20260617 → appends a pre-release identifier (SemVer §9) before the build hash.
// Stable:  0.0.1
// Beta:    0.0.1-beta.1   (set by release-please, not this script)
// Nightly: 0.0.1-nightly.20260617+abc1234
const prereleaseArg = process.argv.find((a) => a.startsWith('--prerelease='))?.slice('--prerelease='.length);
const VERSION = [rootPkg.version, prereleaseArg ? `-${prereleaseArg}` : '', buildArg ? `+${buildArg}` : ''].join('');
const BUILD_ALL = process.argv.includes('--all');

// `libc` only applies to linux: glibc (default, broad desktop/server distros) vs musl (Alpine and
// most embedded/Buildroot rootfs). Bun ships distinct compile targets per libc; a glibc binary
// will not run on a musl-only system and vice versa, so embedded Linux needs its own musl artifact.
type Target = { os: 'darwin' | 'linux' | 'windows'; arch: 'arm64' | 'x64'; libc?: 'musl' };

/** `linux-arm64-musl` etc. — the suffix shared by Bun's compile target and our artifact name. */
function triple(t: Target): string {
  return `${t.os}-${t.arch}${t.libc ? `-${t.libc}` : ''}`;
}

const HOST: Target = {
  os: process.platform === 'darwin' ? 'darwin' : 'linux',
  arch: process.arch === 'arm64' ? 'arm64' : 'x64',
  // A host build on Alpine/musl wants a musl binary; pass --musl (or set when the rootfs is musl).
  ...(process.platform === 'linux' && process.argv.includes('--musl') ? { libc: 'musl' as const } : {})
};
if (process.platform !== 'darwin' && process.platform !== 'linux') {
  process.stderr.write('Build script must run on darwin or linux (cross-compiles to windows).\n');
  process.exit(1);
}
// --os=darwin (or --os=linux,windows) restricts the build to those OSes. The release runs the
// build matrix split by OS — darwin on a macOS runner (Cocoa can't cross-compile), linux+windows
// cross-compiled on Linux — so each runner emits only its slice.
const osArg = process.argv.find((a) => a.startsWith('--os='))?.slice('--os='.length);
const osFilter = osArg ? new Set(osArg.split(',')) : null;

const TARGETS: Target[] = (
  BUILD_ALL
    ? [
        { os: 'darwin', arch: 'arm64' },
        { os: 'darwin', arch: 'x64' },
        { os: 'linux', arch: 'arm64' },
        { os: 'linux', arch: 'x64' },
        { os: 'linux', arch: 'arm64', libc: 'musl' }, // embedded Linux / Alpine (ARM SBCs)
        { os: 'linux', arch: 'x64', libc: 'musl' }, // embedded Linux / Alpine (x64)
        { os: 'windows', arch: 'x64' },
        { os: 'windows', arch: 'arm64' }
      ]
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

log(`Building monad ${VERSION} for: ${TARGETS.map((t) => `${t.os}-${t.arch}`).join(', ')}`);

// ── 0. Install workspace deps ─────────────────────────────────────────────────
log('Installing workspace dependencies…');
await $`bun install`.cwd(ROOT);
await $`bun run ${join(ROOT, 'packages/home/scripts/gen-config-schema.ts')}`;
// Regenerate the native Mo atlas header from the manifest before any shell build.
await $`bun run ${join(ROOT, 'scripts/gen-mo-atlas.ts')}`;
await $`bun run ${join(ROOT, 'scripts/generate-licenses.ts')}`;

// ── 1. Web: static export (platform-independent; done once) ──────────────────
log('Building apps/web static export…');
await $`bun run export`.cwd(join(ROOT, 'apps/web')).env({ ...Bun.env, NODE_ENV: 'production', NEXT_OUTPUT: 'export' });
if (!existsSync(join(ROOT, 'apps/web/out/index.html'))) {
  process.stderr.write('next export did not produce apps/web/out/index.html\n');
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
    if (existsSync(artifactDir)) rmSync(artifactDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });

    const isWindows = t.os === 'windows';
    const binName = isWindows ? 'monad.exe' : 'monad';

    // ── 2a. Compile native sandbox launchers ────────────────────────────────────
    // Ship alongside bin/monad as bin/monad-sandbox-launcher[.exe] (Low IL / Landlock)
    // and bin/monad-sandbox-appcontainer.exe (AppContainer, Windows-only, preferred).
    // Skipped gracefully when the cross-compiler isn't found.
    if (t.os === 'linux') {
      const launcherSrc = join(ROOT, 'apps/monad/native/sandbox-launcher/main.c');
      const launcherOut = join(binDir, 'monad-sandbox-launcher');
      const cc =
        t.libc === 'musl'
          ? t.arch === 'arm64'
            ? 'aarch64-linux-musl-gcc'
            : 'musl-gcc'
          : t.arch === 'arm64'
            ? 'aarch64-linux-gnu-gcc'
            : 'gcc';
      const r = await $`${cc} -O2 -s -static -o ${launcherOut} ${launcherSrc}`.nothrow().quiet();
      if (r.exitCode !== 0) {
        log(`  ⚠ ${cc} not found — ${artifact} sandbox launcher omitted (child runs unconfined on Linux)`);
      } else {
        log(`  ✓ sandbox launcher (${cc})`);
      }
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
    }

    log(`Compiling ${artifact} (bun-${triple(t)})…`);
    const res = await Bun.build({
      entrypoints: [join(ROOT, 'apps/cli/src/bin.ts'), ...webFiles],
      compile: {
        target: `bun-${t.os}-${t.arch}${t.libc ? `-${t.libc}` : ''}` as Bun.Build.CompileTarget,
        outfile: join(binDir, binName)
      },
      // Assets keep clean paths; entry wrappers get hashes to prevent name collisions when two
      // web files share the same basename (e.g. _not-found.html + _not-found.txt → _not-found.js).
      naming: { entry: '[dir]/[name]-[hash].[ext]', asset: '[dir]/[name].[ext]' },
      loader: webLoader,
      minify: true,
      plugins: [stubReactDevtools],
      define: {
        BUILD_VERSION: JSON.stringify(VERSION),
        'Bun.env.NODE_ENV': JSON.stringify('production')
      }
    });
    if (!res.success) {
      for (const l of res.logs) process.stderr.write(`${l.message}\n`);
      throw new Error(`compile failed for ${artifact}`);
    }

    // ── 2b. Bundle the Mo desktop sprite (macOS only, for now) ───────────────────
    // Mo is a native GUI (Cocoa), not a Bun module — it can't be compiled into bin/monad, so it
    // ships alongside it like bin/monad-sandbox-launcher and the daemon auto-locates it
    // (MoService.bundledPath). Only the darwin slice carries Mo today: it gets a universal Mo.app
    // (one bundle serves both arches). Linux/Windows ship without Mo for now (the Linux GTK shell
    // exists but isn't atlas-wired; Windows has no shell) — the web/cli Launch button then reports
    // "not found", which is harmless. Cocoa can't cross-compile, so this must run on a macOS host.
    if (t.os === 'darwin') {
      if (HOST.os === 'darwin') {
        const r = await $`bash ${join(ROOT, 'apps/mo/native/macos/build.sh')} ${join(binDir, 'Mo.app')}`
          .env({ ...Bun.env, MO_UNIVERSAL: '1' })
          .nothrow()
          .quiet();
        log(r.exitCode === 0 ? '  ✓ Mo.app (universal)' : `  ⚠ Mo.app build failed — ${artifact} ships without Mo`);
      } else {
        log(`  ⚠ Mo.app needs a macOS host — ${artifact} ships without Mo (build the darwin slice on macOS)`);
      }
    }

    // ── 3. tar + sha256 ────────────────────────────────────────────────────────
    const tarball = `${artifact}.tar.gz`;
    await $`tar -czf ${join(DIST, tarball)} -C ${DIST} ${artifact}`;
    const sha =
      HOST.os === 'darwin'
        ? (await $`shasum -a 256 ${join(DIST, tarball)}`.quiet()).stdout.toString()
        : (await $`sha256sum ${join(DIST, tarball)}`.quiet()).stdout.toString();
    writeFileSync(join(DIST, `${tarball}.sha256`), sha);
    log(`  ✓ dist/${tarball}`);
  }
} finally {
  // Restore the auto-generated next-env.d.ts, which Next flips between dev/prod type-import
  // paths on each build.
  await $`git checkout -- apps/web/next-env.d.ts`.cwd(ROOT).quiet().nothrow();
  if (existsSync(webOutGzipDir)) rmSync(webOutGzipDir, { recursive: true });
}

const hostArtifact = `monad-${VERSION}-${HOST.os}-${HOST.arch}`;
process.stdout.write(`
Done. Self-contained install test (nothing outside dist/ is touched):

  bun run install:test

Or verify the host binary directly:
  ./dist/${hostArtifact}/bin/monad --help
  ./dist/${hostArtifact}/bin/monad up        # daemon + web together
`);

function log(msg: string) {
  process.stdout.write(`[build-release] ${msg}\n`);
}
