# Release Build Support for Mem0 Optional Peers

## Context

The host release build imports `mem0ai/oss` into the self-contained Monad binary. `mem0ai` 3.1.0 contains literal dynamic imports for optional provider SDKs such as `@huggingface/transformers`. Bun resolves those imports while compiling, even when Monad never selects the corresponding Mem0 provider. A clean workspace therefore fails `bun run build:release` with `Could not resolve: "@huggingface/transformers"`.

Mem0 declares these SDKs in `peerDependencies` and marks them optional in `peerDependenciesMeta`. That package manifest is the authoritative compatibility contract; Monad should not maintain a second hand-written list.

## Goals

- Allow `bun run build:release` to compile from a clean install without installing Mem0's optional provider SDKs.
- Preserve Mem0's runtime optional-peer behavior for operators who intentionally select one of those providers.
- Keep the default Monad memory backend and bundled `mem0ai/oss` implementation unchanged.
- Build the host release from the current `main`, install it locally, and verify the daemon and embedded web UI.

## Non-goals

- Bundle every Mem0 provider SDK into the Monad executable.
- Change Monad's memory configuration or provider selection.
- Add `@huggingface/transformers` or another optional Mem0 peer as a Monad dependency.
- Repair unrelated release, daemon, or UI behavior.

## Design

Add a focused release helper under `scripts/lib/` that reads `apps/monad/node_modules/mem0ai/package.json`, selects peer dependency names whose `peerDependenciesMeta` entry has `optional: true`, and returns a sorted, deduplicated list. The helper validates the manifest shape and fails with a path-specific error when the manifest cannot provide the required metadata.

`scripts/build-release.ts` will call the helper after `bun install` and pass the returned package names to Bun's `external` build option. Bun treats the package names and their subpaths as external imports, so imports such as `mysql2/promise` follow the same optional-peer rule as `mysql2`.

The compiled binary remains self-contained for Monad's supported default paths. A Mem0 backend that requires an optional SDK continues to load that SDK only when selected. If the SDK is absent, Mem0's existing provider-specific error remains the runtime failure boundary.

## Error handling

The build must fail early with a clear error if the installed Mem0 manifest is missing, malformed, or does not expose an optional-peer map. Silently returning an empty list would recreate the current opaque bundler failure and hide package-layout drift.

Runtime errors for intentionally selected optional Mem0 providers remain owned by Mem0. Monad will not replace them with generated stubs.

## Testing

Add a unit-level release test that:

1. Reads a fixture package manifest through the helper and asserts the exact sorted external package list.
2. Uses the real installed `mem0ai/oss` entry in a temporary Bun compile smoke test with the helper's external list.
3. Asserts compilation succeeds while `@huggingface/transformers` remains absent from the workspace dependency graph.

Follow red-green TDD: the new test must fail against the current implementation before production code changes, then pass after the helper and build wiring are added. Run the existing release script unit tests in the same scope to guard platform-module and embedded-migration behavior.

## Release and installation verification

After unit tests pass:

1. Run `bun run build:release` for the host `darwin-arm64` target and require exit code 0.
2. Verify the generated tarball checksum and execute its binary directly.
3. Install the generated tarball through `scripts/install.sh` into the standard local Monad installation.
4. Start outside the repository so `.env.local` cannot override release settings.
5. Require `monad --version`, `monad status`, and the web HTTP probe to succeed.
6. Confirm the installed binary checksum matches the newly built artifact and the embedded UI asset identifiers differ from the previously installed stable build.

## Alternatives rejected

- Installing only `@huggingface/transformers` adds a large dependency and fixes only the first currently missing optional peer.
- Generating throw-only module stubs would compile but permanently disable optional providers even when an operator installs their SDK.
- Maintaining a static external list duplicates Mem0's manifest and will drift on future upgrades.
