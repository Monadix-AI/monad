# Host Interaction and Sandbox Hot-Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a transport-neutral schema-driven interaction service and use it to discover, configure, and safely hot-switch built-in and atom-pack sandbox backends.

**Architecture:** Protocol types define safe schemas, presenter capabilities, request lifecycle, and source-qualified sandbox backend views. A daemon `HostInteractionService` owns pending requests and claim leases; clients render the same semantics natively. Sandbox launchers contribute declarative descriptors while a serialized activation service prepares candidates and atomically swaps the global launcher.

**Tech Stack:** TypeScript, Zod, Bun, Elysia, RTK Query, React, existing CLI/TUI transports, `@monad/sdk-atom`, `@monad/sandbox`.

## Global Constraints

- Third parties may declare only confirm, select, and form interactions with string, secret, number, boolean, and select fields.
- No third-party HTML, scripts, frontend components, or executable validators.
- Secret values never enter events, pending lists, transcripts, logs, shell history, or read responses.
- Background requests never steal focus.
- Backend activation is serialized, atomic, fail-closed, and leaves existing processes on their original launcher.
- VM is built-in; Docker and E2B remain third-party contributions with no host UI conditionals.

---

### Task 1: Protocol contracts for Host Interaction

**Files:**
- Create: `packages/protocol/src/interaction.ts`
- Modify: `packages/protocol/src/index.ts`
- Test: `packages/protocol/test/interaction.test.ts`

**Interfaces:**
- Produces `interactionRequestSchema`, `interactionResultSchema`, `interactionPresenterCapabilitiesSchema`, `pendingInteractionSchema`, and their inferred types.

- [ ] **Step 1: Write failing protocol tests** covering valid confirm/form/select requests, rejection of unknown field types and executable-shaped values, secret redaction views, cancellation reasons, and capability payloads.
- [ ] **Step 2: Run** `bun test packages/protocol/test/interaction.test.ts`; expect missing-export failures.
- [ ] **Step 3: Implement discriminated Zod schemas** with explicit limits: at most 32 fields, 100 options per select, title 120 characters, descriptions 2,000 characters, pattern 256 characters, and timeout 1,000–3,600,000 ms.
- [ ] **Step 4: Export the new contract** from `packages/protocol/src/index.ts` and rerun the test; expect PASS.
- [ ] **Step 5: Commit** `feat(protocol): add host interaction contracts`.

### Task 2: Daemon interaction lifecycle and claim leases

**Files:**
- Create: `apps/monad/src/interactions/service.ts`
- Create: `apps/monad/src/interactions/redact.ts`
- Test: `apps/monad/test/unit/interactions/service.test.ts`

**Interfaces:**
- Consumes protocol interaction types.
- Produces `HostInteractionService.request(source, request, routing)`, `listPending()`, `claim(id, presenterId, capabilities)`, `submit(id, leaseToken, values)`, `cancel(id, leaseToken, reason)`, and `releasePresenter(presenterId)`.

- [ ] **Step 1: Write failing lifecycle tests** for preferred presenter, background queueing, incompatible capability refusal, lease exclusivity, lease expiry, exactly-once submit/cancel, timeout, and disconnect behavior.
- [ ] **Step 2: Write failing secret tests** proving pending/list/event-shaped values contain only `{ configured: boolean }` and released claims retain no secret drafts.
- [ ] **Step 3: Run** `bun test apps/monad/test/unit/interactions/service.test.ts`; expect module-not-found.
- [ ] **Step 4: Implement the in-memory service** using injected clock/token generators, a pending map, per-source concurrency cap of 3, presenter leases, and promise resolvers removed before resolution.
- [ ] **Step 5: Implement redaction as an allowlist projection**, never by cloning and deleting secret fields.
- [ ] **Step 6: Rerun tests**; expect PASS.
- [ ] **Step 7: Commit** `feat(monad): add host interaction lifecycle`.

### Task 3: Interaction HTTP/event transport and SDK context

**Files:**
- Modify: `packages/sdk-atom/src/index.ts`
- Create: `apps/monad/src/transports/http/interactions.ts`
- Modify: `apps/monad/src/transports/http.ts`
- Modify: `apps/monad/src/application/lifecycle.ts`
- Test: `apps/monad/test/e2e/interactions-http.test.ts`

**Interfaces:**
- Adds `AtomPackContext.requestInteraction(request): Promise<InteractionResult>`.
- Adds list, claim, submit, and cancel HTTP endpoints and redacted interaction events.

- [ ] **Step 1: Write failing HTTP tests** that create a request through an atom context, list it, claim it with capabilities, submit once, reject a second submit, and verify no secret value appears in serialized responses.
- [ ] **Step 2: Run** `bun test apps/monad/test/e2e/interactions-http.test.ts`; expect missing route/context failures.
- [ ] **Step 3: Add the SDK method** as a host-provided function; packs do not receive the service itself.
- [ ] **Step 4: Wire the singleton service into lifecycle and Elysia routes** with protocol request/response schemas.
- [ ] **Step 5: Rerun HTTP and SDK typechecks** with `bun run --filter @monad/sdk-atom typecheck && bun run --filter @monad/monad typecheck`; expect PASS.
- [ ] **Step 6: Commit** `feat(monad): expose host interactions to atoms`.

### Task 4: CLI, TUI, Web, and ACP presenters

**Files:**
- Create: `apps/web/src/features/interactions/HostInteractionDialog.tsx`
- Create: `apps/web/src/features/interactions/use-host-interactions.ts`
- Modify: `apps/web/src/components/AppProviders.tsx`
- Create: `apps/cli/src/interactions/presenter.ts`
- Modify: `apps/cli/src/main.ts`
- Create: `apps/tui/src/interactions/presenter.tsx`
- Modify: `apps/tui/src/components/Layout.tsx`
- Modify: `apps/tui/src/store/ui.ts`
- Modify: `apps/monad/src/transports/acp/bridges.ts`
- Test: `apps/web/test/unit/host-interaction-dialog.test.ts`
- Test: `apps/cli/test/unit/interaction-presenter.test.ts`
- Test: `apps/tui/test/unit/interaction-presenter.test.tsx`

**Interfaces:**
- Each presenter advertises capabilities and implements claim plus submit/cancel.

- [ ] **Step 1: Write failing presenter tests** for every common field type, secret no-echo behavior, close cancellation, unsupported capability refusal, and source attribution.
- [ ] **Step 2: Implement the Web host dialog** with host-controlled chrome and no backend-specific branches.
- [ ] **Step 3: Implement interactive CLI prompts** and the non-interactive `interaction_required` JSON result plus `monad interaction answer <id>` resume command.
- [ ] **Step 4: Implement the TUI modal in `Layout.tsx`** and extend `store/ui.ts` with an `interaction` overlay using the same semantic fields and keyboard submit/cancel.
- [ ] **Step 5: Map compatible requests in `apps/monad/src/transports/acp/bridges.ts`** to `elicitation/create` and explicitly refuse unsupported schemas.
- [ ] **Step 6: Run the three presenter test files and package typechecks**; expect PASS.
- [ ] **Step 7: Commit** `feat: add host interaction presenters`.

### Task 5: Source-qualified sandbox launcher descriptors

**Files:**
- Modify: `packages/sdk-atom/src/sandbox.ts`
- Modify: `packages/sandbox/src/registry.ts`
- Modify: `packages/monad-power-pack/src/index.ts`
- Modify: `apps/monad/src/atoms/lifecycle.ts`
- Test: `packages/sandbox/test/unit/registry.test.ts`
- Test: `apps/monad/test/unit/atoms/sandbox-atom-load.test.ts`

**Interfaces:**
- Produces `SandboxBackendRef`, launcher descriptor/schema metadata, registry listing with trusted source attribution, and source-qualified lookup.

- [ ] **Step 1: Write failing tests** for built-in `auto` and `vm`, contributed Docker/E2B, duplicate kinds across packs, duplicate source-qualified identities, and VM availability without Power Pack.
- [ ] **Step 2: Run those tests**; expect VM/source metadata failures.
- [ ] **Step 3: Register VM directly from daemon/built-in lifecycle** and remove it from `monadPowerPack.sandboxes`.
- [ ] **Step 4: Extend registry entries** to retain `{source, packId, launcher}` and expose redacted descriptors without hardcoded contributed kinds.
- [ ] **Step 5: Add declarative settings descriptors** to VM and the Power Pack launchers; host code must not inspect their kinds.
- [ ] **Step 6: Rerun tests and typechecks**; expect PASS.
- [ ] **Step 7: Commit** `feat(sandbox): expose source-qualified launcher descriptors`.

### Task 6: Generic backend settings and secure secret persistence

**Files:**
- Modify: `packages/home/src/config/index.ts`
- Modify: `packages/protocol/src/settings/sandbox-settings.ts`
- Modify: `apps/monad/src/handlers/settings/sandbox/index.ts`
- Create: `apps/monad/src/platform/sandbox/backend-settings.ts`
- Test: `apps/monad/test/unit/settings/sandbox-settings.test.ts`

**Interfaces:**
- Produces opaque namespaced backend settings keyed by serialized `SandboxBackendRef`, redacted settings views, and secure secret replace/remove operations.

- [ ] **Step 1: Write failing tests** for normal values, secret write/redaction/replacement/removal, two packs sharing a kind, retained settings for disabled packs, and invalid schema values.
- [ ] **Step 2: Run the test**; expect missing settings APIs.
- [ ] **Step 3: Add config schema** for active backend reference and `backendSettings: Record<string, Record<string, unknown>>` while preserving migration from legacy `backend`.
- [ ] **Step 4: Implement schema-driven validation and auth named-secret writes** with host-generated names `sandbox/<source-key>/<field-id>`.
- [ ] **Step 5: Return only redacted secret state** from settings reads.
- [ ] **Step 6: Rerun tests and home/protocol/monad typechecks**; expect PASS.
- [ ] **Step 7: Commit** `feat(sandbox): persist generic backend settings securely`.

### Task 7: Atomic hot-switch activation service

**Files:**
- Create: `apps/monad/src/platform/sandbox/activation.ts`
- Modify: `apps/monad/src/platform/sandbox/service.ts`
- Modify: `apps/monad/src/handlers/settings/sandbox/index.ts`
- Modify: `apps/monad/src/handlers/atom-pack/atom-pack-packs.ts`
- Test: `apps/monad/test/unit/platform/sandbox-activation.test.ts`

**Interfaces:**
- Produces serialized `activateBackend(ref, submittedSettings)` returning requested/effective refs, status, and cleanup warnings.

- [ ] **Step 1: Write failing tests** for successful atomic swap, prepare failure, unavailable candidate, persistence rollback, concurrent activation serialization, old/new process ownership, cleanup warning, and safe fallback before active-pack disable/removal.
- [ ] **Step 2: Run the test**; expect module-not-found.
- [ ] **Step 3: Implement candidate configure/prepare/probe before swap**, snapshot the prior launcher/config, and expose a single activation mutex.
- [ ] **Step 4: Persist only after runtime swap and restore the old launcher on persistence failure**; never configure `none` as an intermediate state.
- [ ] **Step 5: Integrate atom-pack disable/remove guards** that activate built-in auto first or refuse the mutation.
- [ ] **Step 6: Rerun activation and atom-pack tests**; expect PASS.
- [ ] **Step 7: Commit** `feat(sandbox): hot-switch backends atomically`.

### Task 8: Studio sandbox backend UI and end-to-end verification

**Files:**
- Create: `apps/web/src/features/studio/sandbox/BackendCards.tsx`
- Create: `apps/web/src/features/studio/sandbox/SchemaSettingsForm.tsx`
- Modify: `apps/web/src/features/studio/SandboxDefaults.tsx`
- Modify: `packages/client-rtk/src/endpoints/settings/sandbox/*`
- Modify: `packages/i18n/src/locales/en/web.json`
- Modify: `packages/i18n/src/locales/zh/web.json`
- Test: `apps/web/test/unit/sandbox-backends.test.ts`
- Test: `apps/web/test/e2e/sandbox-backends.spec.ts`

**Interfaces:**
- Consumes backend views, generic schema, redacted settings, Host Interaction, and activation API.

- [ ] **Step 1: Write failing unit tests** for Built-in/Installed grouping, VM without Power Pack, every generic field type, configured secret state, unavailable/preparing/error states, and absence of `e2b`/`docker` conditionals in Studio source.
- [ ] **Step 2: Write failing E2E tests** for Built-in-to-contributed success, failed activation retaining the old backend, and switching back to Auto.
- [ ] **Step 3: Run the tests**; expect missing components/routes.
- [ ] **Step 4: Implement RTK endpoints and generic components**, preserving the existing sandbox policy section below backend controls.
- [ ] **Step 5: Use Host Interaction for missing/replace-secret flows** and show field/card errors in context.
- [ ] **Step 6: Run unit/E2E tests, web typecheck, Biome, and `git diff --check`**; expect PASS.
- [ ] **Step 7: Commit** `feat(web): manage sandbox backends in Studio`.

### Task 9: Full verification and documentation

**Files:**
- Modify: sandbox and third-party atom documentation under `docs/` located with `rg -n "SandboxLauncher|sandbox backend" docs`.

**Interfaces:**
- Documents the final SDK contract, presenter behavior, security model, and migration.

- [ ] **Step 1: Update documentation** with complete launcher schema examples, secret semantics, CLI/TUI behavior, activation failure behavior, and VM built-in ownership.
- [ ] **Step 2: Run focused suites** for protocol, interaction service, transports, presenters, sandbox registry/settings/activation, atom packs, and Studio E2E.
- [ ] **Step 3: Run package typechecks** for protocol, SDK atom, sandbox, home, monad, client RTK, web, CLI, and TUI.
- [ ] **Step 4: Run Biome and `git diff --check`** across all changed files.
- [ ] **Step 5: Commit** `docs: document host interactions and sandbox backends`.
