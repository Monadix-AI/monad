# Testing

Test runner: **Bun** (`bun test`). All tests live under `test/` inside each package or app.

## Quick reference

```sh
bun run test            # full suite (all packages via Turbo)
bun ../../scripts/bun-test.ts test/unit/ --only-failures   # unit tests for the current package
bun ../../scripts/bun-test.ts test/e2e/ --only-failures    # e2e tests for the current package
bun ../../scripts/bun-test.ts test/e2e/*.smoke.test.ts --only-failures   # smoke tests only
bun test/smoke/acp.ts   # subprocess smoke (ACP wire)
```

When targeting a specific package, directory, or file, use `scripts/bun-test.ts`
with `--only-failures` so the output stays focused on failing cases. Use `--loud`
only when you intentionally need passing-case logs.

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

---

## 2. package.json scripts

Every package with tests must expose these scripts:

```json
{
  "test":      "bun ../../scripts/bun-test.ts test/ --only-failures",
  "test:unit": "bun ../../scripts/bun-test.ts test/unit/ --only-failures",
  "test:e2e":  "bun ../../scripts/bun-test.ts test/e2e/ --only-failures"
}
```

Omit `test:e2e` when the package has no `test/e2e/` directory. The scripts must stay consistent so `turbo run test:unit` works across the monorepo.

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

### 5b. Subprocess smoke (`test/smoke/*.ts`)

Required when the test must cross a real process boundary (stdio, IPC, install scripts). Cannot run inside `bun test` because the test process and the daemon would be the same process.

- Lives at repo root `test/smoke/{feature}.ts` (no `.test.ts` suffix).
- Exits non-zero on failure — CI-able without a test framework.
- Run with `bun test/smoke/feature.ts`.

Example: `test/smoke/acp.ts` — spawns `monad --acp` as a child process and drives it with the ACP SDK over stdio.

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
