# Platform Host Utilities and Startup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend build-time platform module selection to sandbox host lifecycle, shared host desktop utilities, and startup registration.

**Architecture:** Stable development seams preserve platform injection tests; release builds redirect those seams to target-only implementations through one declarative manifest. Shared modules own orchestration and spawning, while target modules own command construction, paths, renderers, and native integration.

**Tech Stack:** TypeScript 7, Bun 1.3.14 plugins/tests, workspace packages, macOS LaunchAgents, Linux XDG autostart, Windows PowerShell/shortcuts

## Global Constraints

- Use `HostSandboxPlatform`, `hostSandboxPlatform`, and `sandbox-platform.*.ts`; remove the `LightSandboxPlatform` naming.
- Preserve all current public API signatures and platform injection used by source tests.
- Windows URL opening must carry the URL through an environment variable into static PowerShell source, never `cmd /c start`.
- Release selection must remain exact-path, fail-closed, and independent of tree shaking.
- Do not stage or modify existing unrelated `packages/sandbox-vm` changes.

---

### Task 1: Host Sandbox Lifecycle and Naming

**Files:**
- Rename: `packages/sandbox/src/light-platform-contract.ts` to `packages/sandbox/src/sandbox-platform-contract.ts`
- Rename: `packages/sandbox/src/light-platform*.ts` to `packages/sandbox/src/sandbox-platform*.ts`
- Modify: `packages/sandbox/src/registry.ts`
- Modify: `apps/monad/src/bootstrap/sandbox.ts`
- Modify: `packages/sandbox/test/unit/light-platform.test.ts`

**Interfaces:**
- Produces: `HostSandboxPlatform { launchers; prepareHost(); disposeHost(); }`
- Produces: `prepareSandboxHost()` and `disposeSandboxHost()` registry functions.

- [ ] Write tests expecting `hostSandboxPlatform`, `prepareHost`, `disposeHost`, and registry lifecycle functions.
- [ ] Run focused tests and verify they fail on missing exports.
- [ ] Rename seam files/symbols, delegate Windows prepare to `sweepOrphanAppContainerProfiles`, and make other hooks no-op.
- [ ] Replace daemon bootstrap's AppContainer-specific call with `prepareSandboxHost()`.
- [ ] Run sandbox tests/typecheck and commit as `refactor(sandbox): generalize host platform lifecycle`.

### Task 2: Shared Host Platform Utilities

**Files:**
- Create: `packages/home/src/host-platform-contract.ts`
- Create: `packages/home/src/host-platform.ts`
- Create: `packages/home/src/host-platform.darwin.ts`
- Create: `packages/home/src/host-platform.linux.ts`
- Create: `packages/home/src/host-platform.windows.ts`
- Modify: `packages/home/src/pick-directory.ts`
- Modify: `packages/home/src/open-url.ts`
- Create: `packages/home/src/open-native-path.ts`
- Modify: `packages/home/src/index.ts`
- Delete: `apps/monad/src/platform/open-native-path.ts`
- Modify: daemon callers and home/workspace-action tests.

**Interfaces:**
- Produces: `HostCommand`, `HostPlatformUtils`, `hostPlatformFor(platform)`, `hostPlatformUtils`.
- Preserves: `pickDirectory`, `directoryPickerSpecs`, `openUrl`, `openNativePath`, and `nativeOpenPathCommands`.

- [ ] Write failing pure command tests for picker, URL, path open, and reveal on all platforms.
- [ ] Implement target objects with exact current argv/env behavior, except Windows URL uses static `Start-Process -LiteralPath $env:MONAD_OPEN_URL`.
- [ ] Refactor shared spawning/timeout/in-flight logic to consume the stable seam.
- [ ] Move native path API to `@monad/home` and update daemon callers.
- [ ] Run home and workspace-action tests/typechecks; commit as `refactor(home): unify host platform utilities`.

### Task 3: Startup Registration Platform Seam

**Files:**
- Create: `apps/monad/src/handlers/settings/startup/startup-platform-contract.ts`
- Create: `apps/monad/src/handlers/settings/startup/startup-platform.ts`
- Create: `apps/monad/src/handlers/settings/startup/startup-platform.darwin.ts`
- Create: `apps/monad/src/handlers/settings/startup/startup-platform.linux.ts`
- Create: `apps/monad/src/handlers/settings/startup/startup-platform.windows.ts`
- Modify: `apps/monad/src/handlers/settings/startup/index.ts`
- Split or replace: `apps/monad/src/handlers/settings/startup/platform-files.ts`
- Modify: `apps/monad/test/unit/settings/startup-settings.test.ts`

**Interfaces:**
- Produces: `StartupPlatform`, `startupPlatformFor(platform)`, and target-only registrar/write behavior.
- Preserves: `createStartupSettingsModule(options)` public behavior and test injections.

- [ ] Add failing contract tests for exact platform selection and mismatch rejection.
- [ ] Extract target paths, legacy paths, native registrar, and writer behavior into target modules.
- [ ] Keep identity, command resolution, state flow, removal, and genuinely shared quoting helpers common.
- [ ] Run startup tests and monad typecheck; commit as `refactor(monad): split startup registration by platform`.

### Task 4: Declarative Release Platform Manifest

**Files:**
- Modify: `scripts/lib/release-platform-modules.ts`
- Modify: `scripts/build-release.ts`
- Modify: `scripts/test/unit/build-release-platform-modules.test.ts`
- Modify: `scripts/test/unit/platform-modules.test.ts` if multi-rule fixture coverage needs expansion.

**Interfaces:**
- Replaces: `sandboxPlatformModuleRule(root)`.
- Produces: `releasePlatformModuleRules(root): PlatformModuleRule[]` with sandbox, home host-utils, and startup rules.

- [ ] Write failing tests asserting three seams and nine exact target mappings.
- [ ] Implement the declarative manifest and make `build-release.ts` consume it without subsystem knowledge.
- [ ] Run focused resolver, sandbox, home, and startup tests plus package typechecks.
- [ ] Run `bun run lint`, `bun run typecheck`, `bun run test:unit`, `bun run knip`, and `bun run scripts/build-release.ts`.
- [ ] Commit as `feat(release): expand platform module manifest` and report actual platform verification limits.
