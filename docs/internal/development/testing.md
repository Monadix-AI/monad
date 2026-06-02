---
title: "Testing"
audience: "internal-developer"
description: "Write and run observable-behavior tests across Bun unit, daemon transport, browser, and provider integration layers."
---
Test runners:
- **Bun** (`bun test`) for package-local unit and daemon/runtime e2e tests.
- **Playwright** for browser e2e tests in `apps/web/test/e2e`.

All tests live under `test/` inside each package or app.

## Quick reference

```sh
bun run test            # full unit + e2e suite
bun run test:unit       # all package-local unit suites through Turbo
bun run test:e2e        # all project e2e suites (daemon + web)
mise run test:e2e:daemon # daemon/runtime e2e only
mise run test:e2e:web    # web Playwright e2e only
bun ../../scripts/bun-test.ts test/e2e/*.smoke.test.ts --only-failures   # smoke tests only
mise run smoke:mesh-agent-managed   # subprocess smoke (managed third-party agent runtime)
```

When targeting a specific package, directory, or file, use `scripts/bun-test.ts`
with `--only-failures` so the output stays focused on failing cases. Agents must not
use `:loud` scripts or pass `--loud`; narrow the test scope and keep the quiet failure
filter enabled when investigating a failure.

For final verification or any broad quality gate, collect the whole failure surface
before fixing: run typecheck, lint, and the relevant test suites once, record every
failure/error, then make one concentrated repair pass. Continue to the next command
after a failure when doing so is safe; the follow-up verification must still make the
entire gate pass cleanly.

---

## 1. Directory structure

Every package that has tests follows this layout:

```text
packages/{name}/
├── src/
└── test/
    ├── unit/        ← pure-logic, no IO
    ├── e2e/         ← real transports, real SQLite, cross-module flows
    │   └── *.smoke.test.ts   ← one golden-path roundtrip (see §5)
    └── fixtures/    ← (optional) two kinds of content:
                         • static data files (JSON, text samples, binary blobs)
                         • factory functions and test doubles (*.ts)
```

The same layout applies to non-package directories that contain tests — e.g. `scripts/test/unit/`.

Rules:
- Test files must not live next to `src/` files (`runner.test.ts` is a legacy exception).
- File naming: `{concern}.test.ts` — name by the behaviour or feature under test, not the source file. One concern may span multiple source files; one source file may be split into multiple concern-focused test files.
- Platform-specific tests use **separate files**: `{concern}.{platform}.test.ts` where platform is `windows`, `unix`, `macos`, or `linux`. Do not use `if (process.platform === …)` guards inside shared test files. The test runner (`scripts/bun-test.ts`) passes `--path-ignore-patterns` automatically so non-matching platform files are never loaded — no runtime skip needed.
- Every new or modified test case must execute behavior and assert its observable outcome: returned contracts, state transitions, emitted events, transport responses, user interactions, side effects, or errors. A case that only proves something exists or does not exist is invalid, regardless of whether the subject is a function, field, entity, registry entry, DOM node, file, mock, or component.
- Presence or absence may be asserted only when it is an observable consequence of the behavior exercised by the case. Examples include an item appearing after creation, disappearing after deletion or dismissal, a field being removed by redaction, a lookup returning not-found, or a pagination cursor ending after the final page. Assert the operation and its exact consequence; do not inspect static initial structure and call that behavior.
- Do not serialize a component and assert its tags, attributes, classes, inline styles, SVG paths, or test markers. Those assertions repeat the JSX implementation without proving an interaction or state change. Exact rendered copy, redaction, and accessibility output may still be contracts when they catch a named user-visible failure.
- Do not read implementation source and assert that fixed code or copy exists as a proxy for runtime behavior. Source analysis is reserved for generated artifacts, release bundles, migrations, compiler transformations, enforceable architecture audits that report exact violations, and other cases where source text is the product under test; mark one-line artifact assertions with `// artifact-ok: <reason>`.

### Existence → behavior: how to rewrite

The litmus test for every case: **what operation ran, and what observable result did it
cause?** If the answer is only “this thing exists/does not exist,” delete or rewrite the
case. Common rewrites:

| Task | Existence test (wrong) | Behavior test (right) |
|---|---|---|
| Added a field/feature | `expect(res.newField).toBeDefined()` | `expect(res).toEqual({ …full exact shape… })` — exact equality proves the field AND its value AND that nothing else changed |
| Removed a field | `expect(res.oldField).toBeUndefined()` as its own case | delete the field from the type and let `tsc` find every reference; make the wire schema `.strict()` so extra keys fail parse; update the existing `toEqual` full-shape assertions — removal falls out of them |
| Added a handler/route/registry entry | `expect(registry.get('x')).toBeDefined()` | call it through the public dispatch path and assert its exact response/effect |
| UI: added a button | `expect(screen.getByRole('button')).toBeInTheDocument()` — `getBy*` already throws when absent, so this asserts nothing | fire the interaction and assert the outcome: `await user.click(screen.getByRole('button', { name: 'Create session' })); expect(onCreate).toHaveBeenCalledWith(…)` |
| UI: removed an element | inspect the initial render and assert “is gone” | perform the behavior that removes it, such as dismissal or redaction, then assert the resulting UI state; `queryBy* … not.toBeInTheDocument()` is valid only for that caused result |
| Create/delete lifecycle | query a fixture and assert the row exists or is absent | perform create/delete, then assert the exact returned contract and resulting lookup/list state |
| Guard/branch exists | `expect(result).toBeTruthy()` | drive the branch with the input that selects it and assert the exact branch-specific output or error |

Deletion/refactor tasks specifically: the verification ladder is
**typecheck > strict schema parse > exact `toEqual` on the public contract**. A test
case whose only claim is "the thing is gone from the source" duplicates what the
compiler already guarantees and rots immediately.

The Biome plugin in `config/biome/weak-test-assertions.grit` rejects weak existence
matchers, serialized markup structure, presentation-prop snapshots, direct layout
measurements, and source-code proxy assertions in test files. When the matched shape
is itself the observable result caused by the behavior under test, keep the assertion
exact and waive the line with
`// biome-ignore lint/plugin: <operation and consequence>`.

`mise run quality:test-assertions` only complements the AST plugin where GritQL has no
data flow: a layout measurement stored in a variable and asserted later. Mark an
intentional layout contract with `// behavior-ok: <operation and consequence>`.

---

## 2. package.json scripts

Script names are layered by where they run:

- Package-local scripts use generic names because the package is already the scope.
- Root scripts aggregate a whole test kind or expose stable CI selectors.
- Target suffixes come after the test kind: `test:e2e:web`, `test:e2e:daemon`.
- Operational and platform-specific suites use mise tasks, such as `mise run test:e2e:binary`.

Root `package.json` scripts:

```json
{
  "test": "all unit and e2e suites",
  "test:unit": "all package-local unit suites through Turbo plus root script tests",
  "test:e2e": "all project e2e suites"
}
```

Per-target selectors are mise tasks, not root scripts — `mise run test:e2e:daemon`
(apps/monad daemon/runtime e2e) and `mise run test:e2e:web` (apps/web Playwright e2e).

Every package with Bun tests exposes `test` as its unit suite. Add e2e scripts only
when the matching directory exists:

```json
{
  "test":      "bun ../../scripts/quiet-run.ts bun ../../scripts/bun-test.ts test/unit/ --only-failures",
  "test:e2e":  "bun ../../scripts/quiet-run.ts bun ../../scripts/bun-test.ts test/e2e/ --only-failures"
}
```

Packages whose unit tests live directly under `test/` use that path instead. Omit
`test:e2e` when the package has no automated e2e suite. Each workspace with quality
scripts also sets `[run] silent = true` in its local `bunfig.toml`; Bun prints the
script command before the wrapper starts otherwise.

`apps/web` is the browser-runner exception for e2e:

```json
{
  "test:e2e": "bun ../../scripts/quiet-run.ts playwright test --reporter=dot"
}
```

Keep these names consistent so Turbo can aggregate `test` and `test:e2e` directly
without package-level forwarding aliases.

Verbose output is an invocation option, not a second script tree. For manual
debugging, run `bun scripts/bun-test.ts <path> --loud`; for browser e2e, run
`bun run --cwd apps/web playwright test --reporter=list`. Agents must continue to
use the quiet wrapper with `--only-failures`.

Repository quality commands (`bun run lint`, `bun run typecheck`, `bun run test`,
and their public unit/e2e variants) are silent when they pass and replay their
captured diagnostics when they fail. Pass `--loud` only during manual debugging to
stream all output; nested package tests inherit that mode.

### Browser e2e is not hermetic by default

`playwright.config.ts` sets `reuseExistingServer: !process.env.CI` and resolves its port
from `.env.local`'s `WEB_PORT`, so a local run attaches to **your dev server** instead of
starting its own. That is deliberate — it makes iterating on one spec fast — but it means
a local result is only as trustworthy as that server: restart `mise run dev` mid-run and
every remaining test fails with `ERR_CONNECTION_REFUSED` against a page that was never
served, which reads like a wave of assertion failures.

When the number matters — judging suite health, reproducing a CI failure, or collecting a
failure list to work through — force the isolated path with the same settings CI uses:

```bash
cd apps/web && CI=1 WEB_PORT=<free port> bun playwright test --reporter=line
```

`CI=1` disables server reuse (Playwright starts and owns its own Vite) and enables the
configured CI retry policy; the explicit port keeps it clear of the dev server. CI itself
is unaffected: `CI` is always set there, and with no `.env.local` the port falls back to
the config's own default.

### Designing high-performance browser E2E cases

Browser E2E is the most expensive test layer. Keep only behavior that depends on a real
browser here: routing, focus, accessibility, layout, scrolling, streaming paint, browser
storage, and complete user workflows. Put parsing, validation, reducers, request shaping,
and branch matrices in unit or integration tests.

#### Intercept only the boundary under test

Never use `page.route('**/*', ...)` and call `route.continue()` for non-API requests. That
runs a Playwright callback for every JavaScript module, stylesheet, font, image, and source
map; under parallel load, one page can create thousands of unnecessary cross-process calls.
Use the shared API pattern or equally narrow route globs:

```ts
import { API_ROUTE_PATTERN } from './api-route-pattern';

await page.route(API_ROUTE_PATTERN, async (route) => {
  const request = route.request();
  const path = new URL(request.url()).pathname.replace('/api/v1', '/v1');
  // Fulfill the API contract used by this scenario.
});
```

Register unrelated special cases as separate narrow routes. Observe requests with
`page.on('request', ...)` when no interception is required. An unhandled API request
should fail explicitly or return a clear error contract; do not silently let it reach a
developer daemon.

#### Wait for outcomes, not elapsed time

Fixed sleeps make the suite both slow and flaky. Choose the wait that matches the
observable behavior:

| Behavior | Preferred wait |
|---|---|
| UI update after an interaction | locator assertion such as `toHaveValue`, `toBeEnabled`, or exact visible output |
| Request or persisted mock state | `expect.poll(() => state)` with an exact expected value |
| Product timeout, debounce, or retry timer | `page.clock` and `fastForward()` |
| Streaming or event completion | a protocol event, request signal, callback, or terminal UI state |
| Browser layout/ResizeObserver settling | consecutive stable animation frames with a bounded maximum |

Use real browser time only when timing is the behavior under test, such as scroll cadence,
streaming paint, delayed reflow, or an animation contract. Even then, wait on the smallest
observable condition. Do not replace a 5-second product timeout with a shorter production
constant just to accelerate its test; hold the mocked request open and advance the browser
clock instead.

For layout tests, a fixed `waitForTimeout(250)` after every gesture is usually wasteful.
Sample the relevant geometry or drift over consecutive `requestAnimationFrame` callbacks
and stop after it remains stable for several frames. Keep a bounded frame count so a
regression fails instead of hanging.

#### Avoid repeated application boot

- Use one full reload only when reload or persistence is part of the contract.
- Prefer in-app navigation between steps when document navigation is not under test.
- Build the scenario through public UI actions, but avoid returning to the same setup
  screen solely to reconstruct state that the mock already controls.
- Keep independent scenarios in separate tests so `fullyParallel` can schedule them.
  Keep a stateful lifecycle in one test only when the transitions themselves are the
  behavior being verified.
- Share immutable fixture builders and route installers, not mutable browser or server
  state across tests.

#### Disable decorative work in logic E2E

The default browser context requests reduced motion. CSS transitions, keyframes, smooth
scrolling, canvas loops, WebGL render loops, and JavaScript animation libraries must honor
`prefers-reduced-motion`. Logic E2E should still execute the interaction and assert its
effect, but it must not wait for decorative motion. Keep dedicated motion or scroll-physics
tests on real rendering paths when motion itself is the contract.

#### Tune parallelism with measurements

More workers stop helping once browser, Vite, or CPU contention lengthens individual tests
or introduces retries. CI sharding and per-run workers multiply each other, so tune them as
one concurrency budget. Prefer shards on separate runners before heavily oversubscribing a
single runner.

Measure before and after with the same isolated server, port policy, worker count, reporter,
and machine:

```bash
cd apps/web
CI=1 PLAYWRIGHT_WORKERS=5 WEB_PORT=<free port> \
  bunx playwright test --reporter=json > /tmp/monad-e2e.json
```

Record all of the following:

- wall-clock duration;
- passed, failed, and flaky counts;
- slowest individual cases;
- retry time;
- CPU saturation when increasing workers.

Run the final configuration again from a fresh Playwright server. An optimization does not
land if it weakens assertions, changes realistic fixtures into parser-only mocks, adds
flakes, or only moves time into retries. Use a trace for unexplained long tails; inspect
action spans, full-page navigations, repeated route callbacks, and fixed waits before
changing worker counts.

---

## 3. Isolation

`bunfig.toml` preloads `scripts/test-setup.ts` before every test run. That script redirects `MONAD_HOME` to `.dev/test-home/{pid}` so no test can touch `~/.monad`.

Additional rules:
- Use `createStore()` (in-memory SQLite) for store tests — never a real path.
- Do not call real LLM APIs or external network endpoints. All model I/O goes through a mock (§4).

---

## 4. Mock model

### Current `ModelChunk` types

`packages/sdk-atom/src/model.ts` defines the streaming contract:

| type | fields | notes |
|------|--------|-------|
| `text` | `token: string` | plain text delta |
| `reasoning` | `token: string` | thinking token (extended thinking, o-series) |
| `tool-call` | `call: ToolCall` | complete tool invocation |
| `finish` | `reason: string` | `stop` / `tool-calls` / `length` / `content-filter` |
| `usage` | `usage: ModelUsage` | terminal chunk with token counts |

Industry-standard chunk types not yet in the protocol (add when the protocol layer supports them):

| type | source | meaning |
|------|--------|---------|
| `tool-input-delta` | AI SDK | streaming partial tool input JSON |
| `source` | AI SDK / provider-native | grounding citation (web-search models) |
| `file` | AI SDK | inline file / code-execution output |
| `error` | AI SDK | inline stream error before finish |

`ModelProvider` also exposes standalone methods (not stream chunks): `generateImage`, `generateSpeech`, `embed`.

### MockModelBuilder

Use `buildMockModel()` from `apps/monad/test/fixtures/mock-model.ts` (the single canonical implementation — do not hand-roll a `mockModel` inline):

```ts
import { buildMockModel } from '../fixtures/mock-model.ts';

// Text-only response (most tests)
const model = buildMockModel().text(['Hello', ' world']).build();

// Tool-calling round-trip
const model = buildMockModel()
  .toolCall({ toolCallId: 'c1', toolName: 'bash', input: { cmd: 'ls' } })
  .finish('tool-calls')
  .build();

// Reasoning + text
const model = buildMockModel()
  .reasoning(['let me think...'])
  .text(['Result: 42'])
  .finish('stop')
  .usage({ inputTokens: 10, outputTokens: 5 })
  .build();
```

Methods for chunk types not yet in the protocol throw `NotImplementedError` at call time — this ensures tests break visibly when the protocol catches up, rather than silently emitting nothing.

For tests that need a full `ModelProvider` (image/speech/embed):

```ts
buildMockImageProvider(imgBytes, 'image/png')
buildMockSpeechProvider(audioBytes, 'audio/mp3')
buildMockEmbedProvider([[0.1, 0.2, 0.3]])
```

---

## 5. Smoke tests

Smoke tests verify a single golden path — not branch coverage. Two kinds:

### 5a. In-process smoke (`*.smoke.test.ts`)

Lives in `test/e2e/`, runs via `scripts/bun-test.ts ... --only-failures`. Uses a local `Bun.serve()` double instead of a real external service.

- 1–3 tests per file, < 5 s total.
- Exercises the real adapter against a mock server boundary.

Example: `apps/monad/test/e2e/channel-telegram-smoke.test.ts` — real Telegram adapter, mock Bot API.

### 5c. Real-binary CLI e2e (`apps/cli/test/e2e/*.e2e.test.ts`)

`apps/cli`'s unit tests drive a mocked Treaty client, which cannot catch argv parsing, the wire
contract, exit codes, or the `--json` frames a script consumes. `cli-daemon-roundtrip.e2e.test.ts`
covers that seam: it boots a real daemon with `--mock-model` on a reserved port under a temporary
`MONAD_HOME`, then shells out to the real CLI entry for each assertion.

- `--mock-model` also reports the home as initialized, so no provider credential has to be seeded.
- Reserve the port by binding `Bun.serve({ port: 0 })` and closing it; never hardcode one.
- Keep it to behavior a mock genuinely cannot reach. It already caught a daemon bug: a missing
  session answered `400 VALIDATION` with its message scrubbed instead of `404 NOT_FOUND`.

### 5b. Subprocess smoke (`test/smoke/*`)

Required when the test must cross a real process boundary (stdio, IPC, install scripts). Cannot run inside `bun test` because the test process and the daemon would be the same process.

- Named `{feature}` with **no `.test.ts` suffix** (the `bun test` glob must not pick it up).
- Exits non-zero on failure — CI-able without a test framework.
- Run directly: `bun <path>/{feature}.ts` (or `pwsh` for a PowerShell smoke).
- **Location follows ownership:**
  - **Package-specific** smoke (drives one package's binary/launcher) lives in that package:
    `packages/<pkg>/test/smoke/{feature}.ts`. Examples: `packages/sandbox/test/smoke/appcontainer-win32.ts`
    (AppContainer launcher), `packages/sandbox-vm/test/smoke/winvm-helper.ps1` (Hyper-V helper).
  - **Cross-cutting / whole-daemon** smoke (spans multiple packages or drives the daemon) lives in
    `scripts/` behind a mise task. Example: `scripts/mesh-agent-managed-smoke.ts`, run with
    `mise run smoke:mesh-agent-managed`.

---

## 6. E2E transport loop

Every `apps/monad` e2e test must cover both transport kinds (TCP loopback and Unix socket) unless the test is platform-specific:

```ts
import { TRANSPORTS, serveTransport } from '../helpers.ts';

for (const kind of TRANSPORTS) {
  describe(`over ${kind}`, () => {
    let t: TransportHandle;
    beforeAll(() => { t = serveTransport(kind, createHttpTransport(buildHandlers(mockModel()))); });
    afterAll(() => t.stop());

    test('health endpoint responds', async () => {
      const res = await t.fetch('/health');
      expect(res.status).toBe(200);
    });
  });
}
```

`TRANSPORTS` is `['tcp', 'unix']` on macOS/Linux and `['tcp']` on Windows.

---

## 7. Factory functions

Avoid building test objects by hand. Each package's `test/fixtures/` (or a `helpers.ts`) should provide factory functions:

```ts
// Naming convention
fixtureSession(overrides?: Partial<Session>): Session
makeToolContext(overrides?: Partial<ToolContext>): ToolContext
```

- Default to sensible values; accept `Partial<T>` overrides.
- Reference: `apps/monad/test/unit/sessions/` (`fixtureSession`) and `apps/monad/test/helpers.ts` (`stubModelDeps`, `buildHandlers`).

---

## 8. Async patterns and resource cleanup

```ts
// Temp directories
const dir = mkdtempSync(join(tmpdir(), 'monad-test-'));
afterAll(() => rm(dir, { recursive: true, force: true }));

// Sockets
beforeAll(() => unlink(SOCK_PATH).catch(() => {}));
afterAll(async () => { server.stop(true); await unlink(SOCK_PATH).catch(() => {}); });

// SSE — event-driven, not sleep-based
const events = await t.sse(path, { until: (e) => e.type === 'agent.done', timeoutMs: 3_000 });
```

Never use `setTimeout` / `Bun.sleep` as a polling mechanism. Wait on events or callbacks.

---

## 9. Frontend testing (`apps/web`, `@monad/ui`)

`apps/web` test strategy:

| kind | how | example |
|------|-----|---------|
| Pure functions | `scripts/bun-test.ts ... --only-failures` | `init-redirect.test.ts` |
| Server / proxy routes | `scripts/bun-test.ts ... --only-failures` + `Bun.serve()` double | `web.test.ts` |
| React components | `scripts/bun-test.ts ... --only-failures` + happy-dom + React Testing Library | `composer-ask-sheet.test.tsx` |

happy-dom is registered at the **app level**, not globally, so server-side packages keep
Bun's native `fetch`/`Response`. `apps/web/bunfig.toml` preloads it before any test file's
module graph is resolved:

```toml
# apps/web/bunfig.toml
[test]
preload = ["./test/register-dom-first.ts"]
```

`register-dom-first.ts` calls `GlobalRegistrator.register()` and then restores Bun's native
network/encoding primitives — read its header comment before changing the order; the
alternatives were tried and fail.

```tsx
// a component test asserts an interaction's effect, never that an element exists
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

test('submitting the composer emits the typed text', async () => {
  const onSubmit = mock();
  render(<Composer onSubmit={onSubmit} />);
  await userEvent.type(screen.getByRole('textbox'), 'hello');
  await userEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(onSubmit).toHaveBeenCalledWith('hello');
});
```

`@monad/ui`'s own suite is deliberately DOM-free: its tests exercise the exported pure
functions behind each component (serialization, key handling, text projection) rather than
rendering markup.

---

## 10. Coverage expectations

| package | expected | scope |
|---------|----------|-------|
| `@monad/protocol` | unit | pure schema / type validators |
| `apps/monad/src/store` | unit + e2e | every table CRUD + migrations |
| daemon agent core (`apps/monad/src/agent`) | unit + e2e | loop, tool calls, compaction |
| `apps/monad` | unit + e2e | every handler, both transports |
| `apps/monad/src/capabilities/tools` | unit | tool dispatch, fs ops, security boundaries |
| `@monad/sandbox`, `@monad/sandbox-vm` | unit + platform smoke | confinement, egress policy, launchers |
| `@monad/environment` | unit | path initialisation |
| `@monad/ui` | unit | exported pure functions behind components |
| `apps/web` | unit (happy-dom + RTL) + Playwright e2e | component interaction, a11y, full flows |
| `apps/tui` | — | TUI rendering cost is high; covered by manual testing |

---

## 11. What not to test

- Pure type definitions (`type`, `interface`).
- Framework glue that directly calls `Bun.serve()` or `bun:sqlite` with no logic of its own.
- Internal implementation details already covered by an outer e2e test.
- In unit and integration tests, avoid assertions whose only claim is that a value
  exists, does not exist, or that static copy contains or omits fixed text. Prefer
  behavior, structure, state transitions, and exact machine contracts. E2E tests may
  assert visible copy because user-facing affordances are part of the behavior.
- Content assertions are useful only when the expected content is derived from a
  dynamic value under test, such as a generated id, computed path, selected model, or
  sanitized secret.
