# Release Mem0 Optional Peers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the current `main` host release compile without installing Mem0's optional provider SDKs, then install and verify that release locally.

**Architecture:** A focused release helper reads Mem0's installed package manifest and derives Bun externals from the package's optional peer metadata. The release compiler consumes that list, leaving default memory behavior bundled while preserving lazy external resolution for opt-in Mem0 providers.

**Tech Stack:** Bun 1.3, TypeScript, `bun:test`, Bun compile API, shell release installer.

## Global Constraints

- Do not add `@huggingface/transformers` or any other Mem0 optional peer to Monad dependencies.
- Do not change runtime memory configuration or provider routing.
- Treat `mem0ai/package.json` as the source of truth; do not maintain a static optional-peer list.
- Run repository tests through `scripts/bun-test.ts ... --only-failures` and never use loud test scripts.
- Build and install only the host `darwin-arm64` artifact.
- Start and verify the installed release outside any checkout containing `.env.local`.

---

### Task 1: Derive Mem0 release externals and wire the compiler

**Files:**
- Create: `scripts/lib/release-optional-peers.ts`
- Create: `scripts/test/unit/build-release-optional-peers.test.ts`
- Modify: `scripts/build-release.ts`

**Interfaces:**
- Produces: `optionalPeerExternals(manifestPath: string): Promise<string[]>`
- Consumes: Mem0's `peerDependencies` and `peerDependenciesMeta` fields from `apps/monad/node_modules/mem0ai/package.json`
- Produces: the exact string array passed to `Bun.build({ external })`

- [ ] **Step 1: Write the failing manifest contract test**

Create `scripts/test/unit/build-release-optional-peers.test.ts` with a temporary package manifest whose optional peers are deliberately unordered. Assert the complete sorted result, including exclusion of required peers and optional metadata entries that are not declared peers:

```ts
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { optionalPeerExternals } from '../../lib/release-optional-peers.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

test('optionalPeerExternals returns declared optional peers in stable order', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'monad-release-optional-peers-'));
  temporaryDirectories.push(directory);
  const manifestPath = join(directory, 'package.json');
  await writeFile(
    manifestPath,
    JSON.stringify({
      peerDependencies: { required: '^1', zebra: '^1', alpha: '^1' },
      peerDependenciesMeta: { zebra: { optional: true }, missing: { optional: true }, alpha: { optional: true } }
    })
  );

  expect(await optionalPeerExternals(manifestPath)).toEqual(['alpha', 'zebra']);
});

test('optionalPeerExternals rejects a manifest without optional peer metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'monad-release-optional-peers-'));
  temporaryDirectories.push(directory);
  const manifestPath = join(directory, 'package.json');
  await writeFile(manifestPath, JSON.stringify({ peerDependencies: { alpha: '^1' } }));

  expect(optionalPeerExternals(manifestPath)).rejects.toThrow(
    `optional peer metadata is missing from ${manifestPath}`
  );
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
bun run scripts/bun-test.ts scripts/test/unit/build-release-optional-peers.test.ts --only-failures
```

Expected: FAIL because `scripts/lib/release-optional-peers.ts` does not exist.

- [ ] **Step 3: Implement the minimal manifest reader**

Create `scripts/lib/release-optional-peers.ts`:

```ts
interface PackageManifest {
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function optionalPeerExternals(manifestPath: string): Promise<string[]> {
  let manifest: PackageManifest;
  try {
    manifest = (await Bun.file(manifestPath).json()) as PackageManifest;
  } catch (error) {
    throw new Error(`could not read optional peers from ${manifestPath}`, { cause: error });
  }
  if (!isRecord(manifest.peerDependencies) || !isRecord(manifest.peerDependenciesMeta)) {
    throw new Error(`optional peer metadata is missing from ${manifestPath}`);
  }
  return Object.entries(manifest.peerDependenciesMeta)
    .filter(([name, metadata]) => isRecord(metadata) && metadata.optional === true && name in manifest.peerDependencies!)
    .map(([name]) => name)
    .sort();
}
```

- [ ] **Step 4: Run the manifest test and verify GREEN**

Run the Step 2 command. Expected: `1 pass`, `0 fail`.

- [ ] **Step 5: Add the real compile regression test and verify RED**

Extend the same test file with this smoke test, initially leaving `external` empty:

```ts
const root = join(import.meta.dir, '..', '..', '..');
const monadDirectory = join(root, 'apps', 'monad');
const mem0Manifest = join(monadDirectory, 'node_modules', 'mem0ai', 'package.json');
const mem0Entry = Bun.resolveSync('mem0ai/oss', monadDirectory);

test('release compile accepts an installed package with unresolved optional peers', async () => {
  expect(() => Bun.resolveSync('@huggingface/transformers', monadDirectory)).toThrow();
  const directory = await mkdtemp(join(tmpdir(), 'monad-release-mem0-compile-'));
  temporaryDirectories.push(directory);
  const entry = join(directory, 'entry.ts');
  await writeFile(entry, `await import(${JSON.stringify(mem0Entry)});\n`);

  const build = await Bun.build({
    entrypoints: [entry],
    outdir: join(directory, 'out'),
    target: 'bun',
    external: []
  });

  expect(build.success, build.logs.map((log) => log.message).join('\n')).toBe(true);
});
```

Run the Step 2 command. Expected: FAIL containing `Could not resolve: "@huggingface/transformers"`.

- [ ] **Step 6: Wire the derived externals into the smoke and production release build**

Replace the smoke test's `external: []` with:

```ts
external: await optionalPeerExternals(mem0Manifest)
```

Update `scripts/build-release.ts` to import the helper:

```ts
import { optionalPeerExternals } from './lib/release-optional-peers.ts';
```

Immediately after the existing `bun install` call, derive the list:

```ts
const optionalExternals = await optionalPeerExternals(
  join(ROOT, 'apps/monad/node_modules/mem0ai/package.json')
);
```

Add this property to the existing `Bun.build` options object after `entrypoints`:

```ts
external: optionalExternals,
```

- [ ] **Step 7: Run the full release-script unit scope**

Run:

```bash
bun run scripts/bun-test.ts \
  scripts/test/unit/build-release-optional-peers.test.ts \
  scripts/test/unit/build-release-platform-modules.test.ts \
  scripts/test/unit/build-release-migrations.test.ts \
  --only-failures
```

Expected: all tests pass with zero failures.

- [ ] **Step 8: Run lint and typecheck for the changed files**

Run:

```bash
bunx biome check scripts/build-release.ts scripts/lib/release-optional-peers.ts scripts/test/unit/build-release-optional-peers.test.ts
bun run typecheck
```

Expected: both commands exit 0.

- [ ] **Step 9: Commit the tested fix**

```bash
git add scripts/build-release.ts scripts/lib/release-optional-peers.ts scripts/test/unit/build-release-optional-peers.test.ts
git commit -m "fix: externalize optional mem0 release peers"
```

### Task 2: Build, install, and verify the current-main release

**Files:**
- Generated: `dist/monad-0.0.2-darwin-arm64/`
- Generated: `dist/monad-0.0.2-darwin-arm64.tar.gz`
- Installed: `/Users/zeke/.monad/bin/monad`

**Interfaces:**
- Consumes: the release build fixed by Task 1
- Produces: a checksum-verified local installation and running daemon

- [ ] **Step 1: Build the real host release**

Run:

```bash
bun run build:release
```

Expected: exit 0 and `dist/monad-0.0.2-darwin-arm64.tar.gz` regenerated from the worktree commit.

- [ ] **Step 2: Verify the artifact before installation**

Run the recorded `.sha256` check, execute `dist/monad-0.0.2-darwin-arm64/bin/monad --version`, and record the artifact binary SHA256. Expected: checksum match and version `0.0.2`.

- [ ] **Step 3: Install through the standard installer**

From `/Users/zeke`, run `scripts/install.sh` with `MONAD_TARBALL` set to the new worktree artifact. Expected: the previous daemon stops, the binary installs under `/Users/zeke/.monad/bin/monad`, and the daemon starts without reading the worktree `.env.local`.

- [ ] **Step 4: Verify the installed release**

Require all of the following:

```bash
MONAD_HOME=/Users/zeke/.monad monad --version
MONAD_HOME=/Users/zeke/.monad monad status
curl --compressed -fsS http://127.0.0.1:52749/ >/dev/null
```

Compare the installed binary SHA256 with the artifact SHA256; they must match. Confirm the daemon process uses `/Users/zeke/.monad/bin/monad`.

- [ ] **Step 5: Verify the embedded UI is from current main**

Compare an asset identifier from the served HTML with the freshly generated `apps/web/out/index.html`, and confirm it is present in the served release response. Expected: at least one current-main asset identifier matches and differs from the prior stable UI identifiers.

- [ ] **Step 6: Final repository verification**

Run:

```bash
git status --short
git log -2 --oneline
```

Expected: clean worktree with the design and implementation commits at the tip.
