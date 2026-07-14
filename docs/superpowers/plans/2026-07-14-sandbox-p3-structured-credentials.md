# Sandbox P3 Structured Credentials Implementation Plan

**Goal:** Materialize structured environment and file credentials into parseable fakes while restoring original bytes only for authenticated configured destinations.

**Architecture:** A bounded host-only materializer produces child-visible values plus explicit fake-to-real substitutions. `SentinelRegistry` owns destination-gated substitutions, `MaskedFileStore` owns fake files, and both the standalone manager and daemon service consume the same contract.

## Task 1: Canonical configuration contract

- Extend `packages/home/src/config/index.ts` with `transform.extract`, `maskDuplicates`, `decode:'jwt'`, and `maskClaims`.
- Accept legacy top-level `extract` and normalize it to `transform.extract`.
- Validate XOR value/file, transform dependencies, unique claim names, and bounded configuration.
- Add parse and canonical-serialization tests.

## Task 2: Bounded credential materializer

- Add `packages/sandbox/src/credential-materializer.ts` and a Bun regex worker.
- Bound credential bytes, capture count, output bytes, JWT bytes/nesting, and regex execution time.
- Implement whole-value, multi-capture extraction, duplicate masking, JWT-shaped fakes, and top-level claim masking.
- Return fixed error enums without secret-bearing messages; add RED/GREEN unit tests.

## Task 3: Registry and destination restoration

- Extend `SentinelRegistry` to register explicit substitutions and child values.
- Preserve per-mapping exact/subdomain host gates and prevent cross-credential restoration.
- Cover structured values, JWT whole-token restoration, denied/sibling/unicode/IP/trailing-dot destinations, and bounded substitution.

## Task 4: File materialization and fail-closed behavior

- Route `MaskedFileStore` through the common materializer.
- Reject oversized, binary, directory, unreadable, ambiguous, invalid-regex, timed-out, and invalid-JWT files by adding the canonical path to `denyPaths`.
- Ensure fake files contain no real credential bytes and cleanup remains owner-only and idempotent.

## Task 5: Standalone manager and daemon wiring

- Update `SandboxManager`, CLI config parsing, and `apps/monad/src/platform/sandbox/service.ts` to use canonical transforms.
- For environment failures omit the variable; for file failures deny the path.
- Publish registry, fake files, proxy hooks, and child env transactionally only after all credentials resolve.

## Task 6: Rotation identity

- Add a non-secret credential generation to `SandboxPolicy` and VM effective identity.
- Increment generation only after successful materialization and dispose replaced fake stores/VM state.
- Verify secret values and hashes never enter policy identity, logs, violations, or persisted output.

## Task 7: Verification and conformance

- Run `@monad/home`, `@monad/sandbox`, daemon sandbox service, `@monad/sandbox-vm`, and SDK gates.
- Extend TLS integration tests for header/body restoration and opaque/oversized paths retaining fakes.
- Add gated real-VM structured-file masking coverage and retain `not run` unless a capable runner executes it.

