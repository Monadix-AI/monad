# Test Suite Isolation Design

## Goal

Separate unit tests, hermetic daemon E2E tests, tests that require installed third-party binaries, and live provider tests so each failure has one clear owner and reliability policy.

## Boundaries

- Unit tests run without network listeners, child provider processes, or live services.
- Hermetic E2E tests may exercise real Monad transports, subprocess fixtures, SQLite, and temporary files, but must not require host-installed provider CLIs, credentials, or public network access.
- Third-party dependency E2E tests run in the existing pinned container image.
- Live provider E2E tests run only in the nightly workflow and never block pull requests.

The existing `test/e2e/live-*.test.ts`, `test/e2e/*.local.test.ts`, and `test/e2e/*.container*.test.ts` naming conventions are the collection contract. Hermetic collection excludes all three before Bun loads the files, rather than relying on runtime `describe.skipIf` calls.

## Runner and coverage

`scripts/bun-test.ts` owns suite-specific ignore patterns. A `--monad-suite=hermetic-e2e` wrapper option adds the live and local exclusions while retaining the existing container exclusion. The option is stripped before invoking `bun test`.

Coverage is opt-in through `MONAD_TEST_COVERAGE=1`. The variable is part of Turbo's global environment hash so coverage and non-coverage results cannot share a cache entry. CI enables it for the Linux unit-test job only, so transport and subprocess timing are not distorted by automatic E2E instrumentation.

## CI

The current cross-platform `test` job becomes two jobs:

1. `unit`, running `bun run test:unit` on Linux, macOS, and Windows. Linux produces coverage. Every package that owns tests must expose `test:unit`, and the root command also runs non-workspace tests under `scripts/test/unit`.
2. `hermetic e2e`, running `bun run test:e2e:daemon` on the same OS matrix and retaining platform launcher compilation.

The existing `e2e deps container` job remains the pinned third-party-binary lane. The nightly `live-e2e` job remains the real-network lane and includes every `live-*.test.ts` suite.

## Compatibility

`bun run test` remains the local aggregate command. Within `apps/monad`, it runs unit and hermetic E2E commands sequentially, preventing the two categories from sharing one Bun test process. Existing focused test commands and explicit live-test commands continue to work.

## Verification

- Unit-test the suite option parser and ignore-pattern output.
- Verify the hermetic command does not collect live or local tests.
- Verify package scripts and workflow YAML reference the new lanes.
- Run formatting/lint checks for changed files and the available focused tests.
