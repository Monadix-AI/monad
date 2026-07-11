# Platform-Specific Release Modules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each compiled release executable resolve sandbox light-launcher imports to an OS-specific module so non-target implementations never enter its dependency graph.

**Architecture:** A reusable Bun build plugin maps an explicit stable seam to an explicit target file and records resolution for a fail-closed post-build audit. The sandbox registry consumes the seam; development resolves an all-platform implementation while release builds redirect it to Darwin, Linux, or Windows implementations.

**Tech Stack:** TypeScript 7, Bun 1.3.14 build plugins, Bun test, Biome, workspace package exports

## Global Constraints

- Correctness must come from build-time module resolution, not `define` substitution or tree shaking.
- Development and ordinary tests must retain cross-platform launcher selection.
- Release builds must fail for unknown platforms, missing target files, unresolved seams, or non-target selections.
- Heavy sandbox backends, policy behavior, launcher priority, and fallback behavior must remain unchanged.
- Platform-specific launchers remain available through explicit package subpaths but are not exported from `@monad/sandbox` root.
- This implementation migrates sandbox only; later subsystems reuse the helper independently.

---

### Task 1: Fail-Closed Platform Module Build Plugin

**Files:**
- Create: `scripts/lib/platform-modules.ts`
- Create: `scripts/test/unit/platform-modules.test.ts`

**Interfaces:**
- Produces: `ReleasePlatform = 'darwin' | 'linux' | 'windows'`
- Produces: `PlatformModuleRule = { seam: string; targets: Record<ReleasePlatform, string> }`
- Produces: `createPlatformModulePlugin(options): { plugin: BunPlugin; assertResolved(): void }`
- Consumes later: `scripts/build-release.ts` supplies absolute seam and target paths.

- [ ] **Step 1: Write failing resolver and audit tests**

Create tests which build a temporary three-file fixture through `Bun.build`: an entry imports `./platform.ts`, the development seam exports `"all"`, and three target files export their platform names. For each release platform, assert the built output contains the target value and not `"all"`. Add negative tests asserting `assertResolved()` throws when the seam was never imported and plugin construction throws when a mapping is incomplete or a mapped file is absent.

```ts
for (const platform of ['darwin', 'linux', 'windows'] as const) {
  const { plugin, assertResolved } = createPlatformModulePlugin({
    platform,
    rules: [{
      seam: join(dir, 'platform.ts'),
      targets: {
        darwin: join(dir, 'platform.darwin.ts'),
        linux: join(dir, 'platform.linux.ts'),
        windows: join(dir, 'platform.windows.ts')
      }
    }]
  });
  const result = await Bun.build({ entrypoints: [join(dir, 'entry.ts')], plugins: [plugin] });
  expect(await result.outputs[0].text()).toContain(platform);
  expect(() => assertResolved()).not.toThrow();
}
```

- [ ] **Step 2: Run tests and verify failure**

Run: `bun test scripts/test/unit/platform-modules.test.ts`

Expected: FAIL because `scripts/lib/platform-modules.ts` does not exist.

- [ ] **Step 3: Implement exact-seam resolver and audit**

Implement `createPlatformModulePlugin` with these rules:

```ts
export type ReleasePlatform = 'darwin' | 'linux' | 'windows';

export interface PlatformModuleRule {
  seam: string;
  targets: Record<ReleasePlatform, string>;
}

export function createPlatformModulePlugin(options: {
  platform: ReleasePlatform;
  rules: PlatformModuleRule[];
}): { plugin: BunPlugin; assertResolved(): void };
```

Normalize every path with `resolve()`, validate all seams and targets with `existsSync()` at construction, and reject duplicate seams. Register an escaped exact basename filter per rule. In `onResolve`, reconstruct the requested absolute path from `args.resolveDir` and `args.path`; redirect only an exact seam match and record it in a `Set`. `assertResolved()` must throw with the unresolved absolute seam paths if any rule was not encountered.

- [ ] **Step 4: Run focused tests**

Run: `bun test scripts/test/unit/platform-modules.test.ts`

Expected: all plugin tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/platform-modules.ts scripts/test/unit/platform-modules.test.ts
git commit -m "feat(build): add platform module resolver"
```

### Task 2: Split Sandbox Light Launcher Set at the Module Boundary

**Files:**
- Create: `packages/sandbox/src/light-platform.ts`
- Create: `packages/sandbox/src/light-platform.darwin.ts`
- Create: `packages/sandbox/src/light-platform.linux.ts`
- Create: `packages/sandbox/src/light-platform.windows.ts`
- Modify: `packages/sandbox/src/registry.ts`
- Modify: `packages/sandbox/src/index.ts`
- Modify: `packages/sandbox/package.json`
- Create: `packages/sandbox/test/unit/light-platform.test.ts`
- Modify: `apps/monad/test/unit/tools/sandbox-registry.test.ts`

**Interfaces:**
- Consumes: existing `SandboxLauncher` and the five launcher objects.
- Produces: each platform file exports `lightSandboxLaunchers: readonly SandboxLauncher[]`.
- Produces: registry continues exporting the existing selection, registration, disposal, and backend-option APIs unchanged.

- [ ] **Step 1: Write failing platform-set tests**

Import each platform file directly and assert exact launcher order:

```ts
expect(darwin.map(({ kind }) => kind)).toEqual(['seatbelt']);
expect(linux.map(({ kind }) => kind)).toEqual(['bwrap', 'landlock']);
expect(windows.map(({ kind }) => kind)).toEqual(['appcontainer', 'win32']);
expect(all.map(({ kind }) => kind)).toEqual(['seatbelt', 'bwrap', 'landlock', 'appcontainer', 'win32']);
```

Extend the existing registry test so `disposeSandboxSession()` verifies the selected development light set and a registered heavy launcher both receive disposal without changing the public API.

- [ ] **Step 2: Run tests and verify failure**

Run: `bun test packages/sandbox/test/unit/light-platform.test.ts apps/monad/test/unit/tools/sandbox-registry.test.ts`

Expected: FAIL because the four platform modules do not exist.

- [ ] **Step 3: Create focused platform modules**

Each file imports only its target launchers and exports a readonly array. `light-platform.ts` imports all launchers for development/test. Change `registry.ts` to import `lightSandboxLaunchers` from `./light-platform.ts` and use it everywhere the current `LIGHT` constant is used.

Remove platform launcher re-exports from `packages/sandbox/src/index.ts`. Keep and verify the existing explicit package exports:

```json
{
  "./launchers/bwrap": "./src/launchers/bwrap.ts",
  "./launchers/landlock": "./src/launchers/landlock.ts",
  "./launchers/seatbelt": "./src/launchers/seatbelt.ts",
  "./launchers/win32": "./src/launchers/win32.ts",
  "./launchers/win32-appcontainer": "./src/launchers/win32-appcontainer.ts"
}
```

- [ ] **Step 4: Run sandbox and application registry tests**

Run: `bun test packages/sandbox/test/unit/light-platform.test.ts apps/monad/test/unit/tools/sandbox-registry.test.ts`

Expected: all focused tests pass.

Run: `bun run --cwd packages/sandbox test:unit`

Expected: 111 or more tests pass, zero failures.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox/src packages/sandbox/package.json packages/sandbox/test/unit/light-platform.test.ts apps/monad/test/unit/tools/sandbox-registry.test.ts
git commit -m "refactor(sandbox): split light launchers by platform"
```

### Task 3: Wire and Enforce Target Resolution in Release Builds

**Files:**
- Modify: `scripts/build-release.ts`
- Create: `scripts/lib/release-platform-modules.ts`
- Create: `scripts/test/unit/build-release-platform-modules.test.ts`

**Interfaces:**
- Consumes: `createPlatformModulePlugin`, `PlatformModuleRule`, and the release target OS.
- Produces: every target build audits that the sandbox seam resolved exactly once to its expected platform file before native packaging.

- [ ] **Step 1: Write failing release mapping tests**

Import a pure `sandboxPlatformModuleRule(root: string): PlatformModuleRule` from `scripts/lib/release-platform-modules.ts`. Assert exact absolute paths for all four files and verify `windows` maps to `light-platform.windows.ts` while runtime platform normalization remains `win32` only inside sandbox launcher metadata.

```ts
expect(rule.targets).toEqual({
  darwin: join(root, 'packages/sandbox/src/light-platform.darwin.ts'),
  linux: join(root, 'packages/sandbox/src/light-platform.linux.ts'),
  windows: join(root, 'packages/sandbox/src/light-platform.windows.ts')
});
```

- [ ] **Step 2: Run test and verify failure**

Run: `bun test scripts/test/unit/build-release-platform-modules.test.ts`

Expected: FAIL because the release mapping helper is not implemented.

- [ ] **Step 3: Add the platform plugin to each compiled target**

Create `scripts/lib/release-platform-modules.ts` to keep the mapping side-effect-free for tests. For each `t` inside the target loop:

```ts
const platformModules = createPlatformModulePlugin({
  platform: t.os,
  rules: [sandboxPlatformModuleRule(ROOT)]
});

const res = await Bun.build({
  // existing options
  plugins: [stubReactDevtools, platformModules.plugin]
});

if (!res.success) throw new Error(...);
platformModules.assertResolved();
```

Run the audit immediately after a successful Bun build and before Mo/native packaging or tar creation. Keep `windows` as the release target key; platform-specific source files own Node's `win32` launcher metadata.

- [ ] **Step 4: Run focused and package verification**

Run: `bun test scripts/test/unit/platform-modules.test.ts scripts/test/unit/build-release-platform-modules.test.ts packages/sandbox/test/unit/light-platform.test.ts apps/monad/test/unit/tools/sandbox-registry.test.ts`

Expected: all tests pass.

Run: `bun run --cwd packages/sandbox typecheck && bun run --cwd apps/monad typecheck`

Expected: both typechecks pass.

- [ ] **Step 5: Verify real host release selection**

Run: `bun run scripts/build-release.ts`

Expected: host artifact builds successfully and the platform-module audit reports no unresolved seam. On macOS the compiled executable selects `light-platform.darwin.ts`; on Linux it selects `light-platform.linux.ts`.

- [ ] **Step 6: Run repository quality gates**

Run: `bun run lint && bun run typecheck && bun run test:unit && bun run knip`

Expected: every command exits zero. If a pre-existing unrelated failure appears, record its exact command and output rather than changing unrelated code.

- [ ] **Step 7: Commit**

```bash
git add scripts/build-release.ts scripts/lib/release-platform-modules.ts scripts/test/unit/build-release-platform-modules.test.ts
git commit -m "feat(release): prune non-target platform modules"
```

### Task 4: Final Contract Review

**Files:**
- Modify only if verification exposes a defect in files listed above.

**Interfaces:**
- Consumes: all implementation and test contracts from Tasks 1–3.
- Produces: evidence that the design spec is fully implemented without unrelated changes.

- [ ] **Step 1: Compare implementation with design constraints**

Verify the root sandbox entry has no platform launcher exports, release code has no `BUILD_PLATFORM` define, the registry has one stable seam import, and every target mapping is explicit.

- [ ] **Step 2: Inspect final diff and commits**

Run: `git diff main...HEAD --check && git status --short && git log --oneline main..HEAD`

Expected: no whitespace errors, clean worktree, and focused design/plugin/sandbox/release commits only.

- [ ] **Step 3: Record verification evidence in the handoff**

Report exact passing commands, host release artifact path, and any platform builds not executed locally. Do not claim Windows or Linux executable verification from a macOS-only host build.
