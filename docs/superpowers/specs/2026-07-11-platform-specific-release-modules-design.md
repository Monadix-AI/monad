# Platform-Specific Release Modules

## Goal

Release artifacts must contain only the operating-system implementations needed by their target. The guarantee must come from module resolution, not from minifier-dependent dead-code elimination. Development and tests must retain the ability to exercise every platform implementation from one host.

The first migration covers the built-in light sandbox launchers and establishes a reusable release-build mechanism for later platform-specific subsystems.

## Current State

`scripts/build-release.ts` already emits a separate Bun executable and native payload for every target. Native sandbox launchers and Mo are selected before packaging. The TypeScript dependency graph is not platform-specific: `packages/sandbox/src/registry.ts` statically imports every light launcher, and the package root re-exports every launcher. Consequently, every release executable can include the macOS, Linux, and Windows TypeScript implementations even though runtime selection uses `launcher.platforms`.

## Decision

Use a stable platform-module seam whose implementation is replaced during release module resolution.

The sandbox registry imports one stable module:

```ts
import { lightSandboxLaunchers } from './light-platform.ts';
```

The source tree provides four implementations:

- `light-platform.ts`: development and test implementation containing all light launchers.
- `light-platform.darwin.ts`: Seatbelt only.
- `light-platform.linux.ts`: bwrap followed by Landlock.
- `light-platform.windows.ts`: AppContainer followed by Low Integrity.

During each target build, a reusable Bun plugin resolves the stable seam to the target-specific file. Non-target platform modules therefore never enter the release dependency graph.

The generic build helper accepts explicit, typed mappings instead of inferring filenames globally. This keeps platform selection auditable and prevents an unrelated file with a similar name from being redirected accidentally.

## Runtime and Test Semantics

Development and ordinary tests resolve `light-platform.ts` normally. This preserves the existing ability to call `selectSandboxLauncher(platform)` with an injected platform and test selection for macOS, Linux, and Windows on one machine.

Platform launcher modules remain available through explicit package subpaths for focused unit and OS integration tests. The package root stops re-exporting platform-specific launchers. Application code imports only platform-neutral sandbox APIs from the root.

No production behavior changes:

- `auto` still chooses the first available light launcher for the current platform.
- Explicit heavy backends remain registered by atom packs and are not platform-pruned.
- Session disposal still covers the selected light launchers and registered heavy launchers.
- Missing native helpers retain their existing availability and fallback behavior.

## Build Contract

For each target, `build-release.ts` creates the platform-module plugin with the normalized Node platform name:

| Release target | Node platform | Sandbox implementation |
| --- | --- | --- |
| `darwin` | `darwin` | Seatbelt |
| `linux` | `linux` | bwrap, Landlock |
| `windows` | `win32` | AppContainer, Low Integrity |

The plugin is applied only to the compiled release executable. Web export and native helper compilation remain unchanged.

The platform module mapping is a build invariant. An unknown target or missing mapped file fails the build rather than falling back to the all-platform development module.

## Verification

Verification has three layers:

1. Unit tests assert the target mapping and exact resolved file for every supported OS.
2. Sandbox registry tests continue asserting cross-platform runtime selection in development mode.
3. A release dependency audit records platform-seam resolution during each Bun build and fails if the development all-platform module or a non-target platform module is selected.

The audit verifies module identity rather than searching the final executable for incidental strings. A small build-level test exercises the plugin against sandbox fixtures without requiring all cross-compilers or a full release build.

Existing sandbox unit tests, package typechecking, repository linting, and release-script tests remain required gates.

## Extensibility

Future migrations add an explicit seam and mapping to the same build helper. Suitable candidates include startup registration, directory selection, TLS/system integration, and native service discovery. A subsystem should migrate only when its platform implementations have a shared contract and release code does not need cross-platform runtime simulation.

The mechanism does not replace ordinary runtime feature detection. Runtime detection remains appropriate for optional binaries, kernel capabilities, configuration, and heavy sandbox backends. Build-time selection is reserved for code that is structurally impossible to use on the target OS.

## Non-Goals

- Migrating every existing `process.platform` branch in this change.
- Creating separate CLI or daemon entrypoints for each OS.
- Changing sandbox policy, launcher priority, or fallback semantics.
- Depending on `define` substitution or tree shaking for correctness.
- Removing explicit launcher subpaths used by tests and advanced consumers.

## Rollout

This change introduces the generic build helper and migrates sandbox in one atomic implementation. Subsequent platform subsystems can migrate independently. If a release build cannot prove the expected platform mapping, it fails before packaging, preventing silent regression to an all-platform bundle.
