# Platform Host Utilities and Startup Registration

## Goal

Extend the release-time platform module architecture beyond sandbox launchers while keeping development-time cross-platform test injection. This change adds generic sandbox host lifecycle hooks, consolidates directory selection plus URL/native-path opening into one `@monad/home` platform seam, moves startup registration behind its own platform seam, and makes release module mappings declarative.

## Scope

Included:

- Sandbox platform host preparation and disposal.
- Native directory picker invocation.
- Opening URLs in the default browser.
- Opening or revealing native filesystem paths.
- macOS, Linux, and Windows startup registration.
- A single release platform-module manifest consumed by `build-release.ts`.

Excluded:

- Opening terminals in a workspace.
- Other `process.platform` branches in TLS, locks, paths, services, or installers.
- Behavior changes to launcher selection, startup files, picker fallbacks, or opener commands.

## Architecture

### Platform module pattern

Each migrated subsystem has:

- A stable development seam imported by production-neutral code.
- One target-specific module for Darwin, Linux, and Windows.
- A shared contract that contains no target implementation.
- A development implementation that dispatches across all platforms for source tests.
- An explicit release rule that redirects only the stable seam.

Release correctness continues to come from module resolution. Target-specific implementations that are not selected never enter the dependency graph.

### Sandbox host lifecycle

Replace the weight-based `LightSandboxPlatform` name and its AppContainer-specific method with the responsibility-based `HostSandboxPlatform` lifecycle:

```ts
interface HostSandboxPlatform {
  launchers: readonly SandboxLauncher[];
  prepareHost(): Promise<void>;
  disposeHost(): Promise<void>;
}
```

The corresponding value is `hostSandboxPlatform`, and the stable seam files are renamed from `light-platform.*.ts` to `sandbox-platform.*.ts`. The Windows implementation runs `sweepOrphanAppContainerProfiles()` during `prepareHost()`. Darwin and Linux preparation are no-ops. All initial `disposeHost()` implementations are no-ops, establishing a symmetric lifecycle for future native helpers and host-level resources.

The sandbox registry exposes `prepareSandboxHost()` and `disposeSandboxHost()`. Daemon bootstrap no longer imports an AppContainer-named function. Host preparation remains best-effort at the current call site, preserving startup behavior.

### Host platform utilities

Create `HostPlatformUtils` under `@monad/home`:

```ts
interface HostPlatformUtils {
  platform: 'darwin' | 'linux' | 'win32';
  directoryPickerSpecs(options: PickDirectoryOptions): readonly HostCommand[];
  openUrlCommand(url: string): HostCommand;
  openPathCommands(path: string, mode: 'open' | 'reveal'): readonly HostCommand[];
}
```

`HostCommand` contains argv and optional environment variables. Platform modules contain only static script text and command construction. Shared modules own spawning, error handling, timeout, in-flight picker serialization, default-path existence checks, and output normalization.

The stable seam files are:

```text
packages/home/src/host-platform.ts
packages/home/src/host-platform.darwin.ts
packages/home/src/host-platform.linux.ts
packages/home/src/host-platform.windows.ts
packages/home/src/host-platform-contract.ts
```

The development seam exports a `hostPlatformFor(platform)` dispatcher so unit tests can exercise all platforms on one host. It also exports the current host object for ordinary runtime calls. Every release-specific module exports the same names, but its dispatcher accepts only its native platform and throws on a mismatch; this preserves one static contract without importing non-target implementations.

Public APIs remain stable:

- `pickDirectory(options)`
- `directoryPickerSpecs(platform, options)` for source-level compatibility and pure tests
- `openUrl(url)`
- `openNativePath(path, mode)`
- `nativeOpenPathCommands(path, mode, platform)` for source-level compatibility and pure tests

The implementation of `openNativePath` moves from `apps/monad/src/platform/open-native-path.ts` into `@monad/home`. Existing daemon callers switch to the package API; the application-local file is removed. URL, path, and picker command construction now share one platform decision boundary.

Security properties are preserved and one existing Windows edge is hardened: prompts/default paths use argv or environment variables rather than script interpolation; Windows path opening uses `-LiteralPath` via environment; Windows URL opening moves from `cmd /c start` to a static PowerShell command with the URL carried in an environment variable so shell metacharacters cannot become commands; opener processes remain detached; picker calls remain serialized and bounded by the existing timeout.

### Startup registration

Create a startup platform contract beside the settings handler:

```ts
interface StartupPlatform {
  platform: 'darwin' | 'linux' | 'win32';
  target(context: StartupContext): StartupTarget;
  legacyTargets(context: StartupContext): readonly string[];
  registrar(context: StartupContext): StartupRegistrar | null;
  write(context: StartupWriteContext): Promise<void>;
}
```

Shared startup code retains:

- `createStartupSettingsModule`
- get/set state flow
- command and identity resolution
- legacy target deletion
- unsupported-platform response
- common escaping and quoting helpers

Platform files own target paths and OS-specific writes:

```text
apps/monad/src/handlers/settings/startup/startup-platform.ts
apps/monad/src/handlers/settings/startup/startup-platform.darwin.ts
apps/monad/src/handlers/settings/startup/startup-platform.linux.ts
apps/monad/src/handlers/settings/startup/startup-platform.windows.ts
apps/monad/src/handlers/settings/startup/startup-platform-contract.ts
```

The development seam dispatches by the injected `StartupSettingsOptions.platform`, preserving the current cross-platform tests. Every target module exports the same `startupPlatformFor(platform)` contract and rejects a non-native platform without importing another implementation. A release module contains only its target registrar, renderer, and writer. Shared renderer/quoting helpers may live in a platform-neutral support file when they are used by more than one target; a target must not import another target implementation.

The existing macOS login-item registrar injection and Windows shortcut writer injection remain supported through the platform context, so unit tests do not require native UI or COM integration.

## Declarative Release Manifest

Replace the single sandbox rule helper with:

```ts
function releasePlatformModuleRules(root: string): PlatformModuleRule[];
```

It returns exactly three rules:

1. Sandbox light platform.
2. Home host platform utilities.
3. Startup registration platform.

`build-release.ts` consumes only this manifest:

```ts
const platformModules = createPlatformModulePlugin({
  platform: target.os,
  rules: releasePlatformModuleRules(ROOT)
});
```

The existing plugin validates every seam and every target, redirects exact resolved paths, and requires every declared seam to be resolved before packaging. Adding a future platform subsystem requires adding one explicit rule to the manifest rather than modifying the build loop.

## Testing

- Sandbox tests assert launcher order plus host lifecycle delegation.
- Home tests assert exact picker, URL, open, and reveal commands for all three platforms and preserve injection-safe argv/env handling.
- Startup tests retain current get/set behavior for all platforms and add direct platform-object contract coverage.
- Manifest tests assert all three seams and all nine target mappings exactly.
- Plugin fixture tests continue proving that each stable seam resolves only to its selected target and that unresolved seams fail the build.
- Package typechecks cover `@monad/home`, `@monad/sandbox`, and `@monad/monad`.
- Final verification runs lint, repository typecheck, unit tests, knip, and a macOS host release build.

Linux and Windows native execution remains CI/platform verification. Local reporting must distinguish fixture/cross-target mapping coverage from actual target executable execution.

## Migration and Compatibility

The migration is atomic from the release build's perspective: the manifest is expanded only after all stable seams and target files exist. Public API call signatures remain compatible. Internal test helpers keep platform injection in development source, while release target modules remove non-target implementation imports.

Unrelated existing changes under `packages/sandbox-vm` are outside this work and must remain unstaged and unmodified.
