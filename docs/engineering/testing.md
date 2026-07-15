# Testing

Test runners:
- **Bun** (`bun test`) for package-local unit and daemon/runtime e2e tests.
- **Playwright** for browser e2e tests in `apps/web/test/e2e`.

All tests live under `test/` inside each package or app.

## Quick reference

```sh
bun run test            # full suite (all packages via Turbo)
bun run test:unit       # all package-local unit suites that expose test:unit
bun run test:e2e        # all project e2e suites (daemon + web)
bun run test:e2e:daemon # daemon/runtime e2e only
bun run test:e2e:web    # web Playwright e2e only
bun run test:loud       # full suite with verbose output
bun run test:unit:loud  # unit suites with verbose output
bun run test:e2e:loud   # e2e suites with verbose output
bun ../../scripts/bun-test.ts test/e2e/*.smoke.test.ts --only-failures   # smoke tests only
bun test/smoke/acp.ts   # subprocess smoke (ACP wire)
```

When targeting a specific package, directory, or file, use `scripts/bun-test.ts`
with `--only-failures` so the output stays focused on failing cases. Use `--loud`
only when you intentionally need passing-case logs.

For final verification or any broad quality gate, collect the whole failure surface
before fixing: run typecheck, lint, and the relevant test suites once, record every
failure/error, then make one concentrated repair pass. Continue to the next command
after a failure when doing so is safe; the follow-up verification must still make the
entire gate pass cleanly.

---

## 1. Directory structure

Every package that has tests follows this layout:

```
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
- Assertions must prove observable behavior: returned contracts, state transitions, emitted events, transport responses, user interactions, side effects, or errors. Do not use `toBeDefined()`, `toBeTruthy()`, or `toBeFalsy()` to prove that a logic branch, entity, registry entry, DOM node, or mock exists; exercise it and assert its result instead.
- Absence assertions are valid only when absence is the public contract, such as redaction, deletion, a not-found response, an optional response field, or pagination termination.
- Do not read implementation source and assert that fixed code or copy exists as a proxy for runtime behavior. Source assertions are reserved for generated artifacts, release bundles, migrations, compiler transformations, and other cases where source text is the product under test.

---

## 2. package.json scripts

Script names are layered by where they run:

- Package-local scripts use generic names because the package is already the scope.
- Root scripts either aggregate a whole test kind or include an explicit target suffix.
- `:loud` always means the same test set with verbose output and no quiet failure filtering.
- Target suffixes come after the test kind: `test:e2e:web`, `test:e2e:daemon`, `test:e2e:binary`.

Root scripts:

```json
{
  "test": "all package-local tests through Turbo",
  "test:loud": "all package-local tests through Turbo with verbose output",
  "test:unit": "all package-local unit tests through Turbo",
  "test:unit:loud": "all package-local unit tests through Turbo with verbose output",
  "test:e2e": "all project e2e suites",
  "test:e2e:loud": "all project e2e suites with verbose output",
  "test:e2e:daemon": "apps/monad daemon/runtime e2e only",
  "test:e2e:daemon:loud": "apps/monad daemon/runtime e2e only, verbose",
  "test:e2e:web": "apps/web Playwright e2e only",
  "test:e2e:web:loud": "apps/web Playwright e2e only, verbose",
  "test:e2e:binary": "packaged binary/install smoke e2e"
}
```

Every package with Bun tests must expose these scripts when the matching
directory exists:

```json
{
  "test":      "bun ../../scripts/bun-test.ts test/ --only-failures",
  "test:loud": "bun ../../scripts/bun-test.ts test/ --loud",
  "test:unit": "bun ../../scripts/bun-test.ts test/unit/ --only-failures",
  "test:unit:loud": "bun ../../scripts/bun-test.ts test/unit/ --loud",
  "test:e2e":  "bun ../../scripts/bun-test.ts test/e2e/ --only-failures",
  "test:e2e:loud": "bun ../../scripts/bun-test.ts test/e2e/ --loud"
}
```

Omit `test:unit` / `test:unit:loud` when the package has no `test/unit/`
directory. Omit `test:e2e` / `test:e2e:loud` when the package has no
`test/e2e/` directory.

`apps/web` is the browser-runner exception for e2e:

```json
{
  "test:e2e": "playwright test",
  "test:e2e:loud": "playwright test --reporter=list"
}
```

Keep these names consistent so root `turbo run test:unit` and targeted root
entrypoints remain predictable across the monorepo.

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
| `reasoning` | `token: string` | thinking token (Claude extended thinking, o-series) |
| `tool-call` | `call: ToolCall` | complete tool invocation |
| `finish` | `reason: string` | `stop` / `tool-calls` / `length` / `content-filter` |
| `usage` | `usage: ModelUsage` | terminal chunk with token counts |

Industry-standard chunk types not yet in the protocol (add when the protocol layer supports them):

| type | source | meaning |
|------|--------|---------|
| `tool-input-delta` | AI SDK | streaming partial tool input JSON |
| `source` | AI SDK / Gemini | grounding citation (web-search models) |
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

### 5b. Subprocess smoke (`test/smoke/*`)

Required when the test must cross a real process boundary (stdio, IPC, install scripts). Cannot run inside `bun test` because the test process and the daemon would be the same process.

- Named `{feature}` with **no `.test.ts` suffix** (the `bun test` glob must not pick it up).
- Exits non-zero on failure — CI-able without a test framework.
- Run directly: `bun <path>/{feature}.ts` (or `pwsh` for a PowerShell smoke).
- **Location follows ownership:**
  - **Package-specific** smoke (drives one package's binary/launcher) lives in that package:
    `packages/<pkg>/test/smoke/{feature}.ts`. Examples: `packages/sandbox/test/smoke/appcontainer-win32.ts`
    (AppContainer launcher), `packages/sandbox-vm/test/smoke/winvm-helper.ps1` (Hyper-V helper).
  - **Cross-cutting / whole-daemon** smoke (spans multiple packages or drives the daemon) lives at
    repo root `test/smoke/{feature}.ts`. Examples: `test/smoke/acp.ts` (spawns `monad --acp`),
    `test/smoke/codex-appserver-*.ts` (daemon + atoms).

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
- Reference: `packages/store/test/unit/sessions-tier1.test.ts` (`fixtureSession`) and `apps/monad/test/helpers.ts` (`stubModelDeps`, `buildHandlers`).

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
| React components | `scripts/bun-test.ts ... --only-failures` + happy-dom + React Testing Library | `button.test.tsx` |

happy-dom is configured at the **package level** to avoid polluting server-side packages:

```toml
# packages/ui/bunfig.toml
[test]
preload = ["./test/setup-dom.ts"]
```

```ts
// packages/ui/test/setup-dom.ts
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();
```

```tsx
// packages/ui/test/unit/button.test.tsx
/// <reference lib="dom" />
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

test('renders label', () => {
  render(<Button>Click me</Button>);
  expect(screen.getByRole('button')).toHaveTextContent('Click me');
});
```

---

## 10. Coverage expectations

| package | expected | scope |
|---------|----------|-------|
| `@monad/protocol` | unit | pure schema / type validators |
| `@monad/store` | unit + e2e | every table CRUD + migrations |
| daemon agent core (`apps/monad/src/agent`) | unit + e2e | loop, tool calls, compaction |
| `apps/monad` | unit + e2e | every handler, both transports |
| `apps/monad/src/capabilities/tools` | unit | sandbox, fs ops, security boundaries |
| `@monad/home` | unit | path initialisation |
| `@monad/ui` | unit (happy-dom + RTL) | component render, interaction, a11y |
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
