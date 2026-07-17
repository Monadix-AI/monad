# Async External Agent Preset Probes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every external-agent preset refresh execute fresh provider probes asynchronously and concurrently without blocking unrelated daemon requests or caching results across requests.

**Architecture:** Add a focused Bun async process runner and a per-invocation batch executor that deduplicates exact launch specs. Convert preset assembly to await one fresh batch, parse each result through the existing adapter contracts, and return existing static fallbacks for failed probes.

**Tech Stack:** Bun, TypeScript, Bun test, Elysia handlers, existing `ExternalAgentProviderAdapter` contracts.

## Global Constraints

- Do not retain completed probe results or in-flight work across HTTP requests.
- Deduplicate identical commands only within one `listExternalAgentPresets` invocation.
- Preserve the existing `{ presets: ExternalAgentPresetView[] }` wire contract.
- Preserve the existing 2,000 ms probe timeout.
- Do not add settings, environment variables, dependencies, logging of commands, or logging of environment values.
- Use Bun APIs for new process execution.

---

### Task 1: Async per-request probe batch

**Files:**
- Create: `apps/monad/src/services/external-agent/probe-batch.ts`
- Test: `apps/monad/test/unit/external-agent-probe-batch.test.ts`

**Interfaces:**
- Consumes: `ExternalAgentLaunchSpec` from `#/services/external-agent/types.ts`.
- Produces: `ExternalAgentProbeResult`, `ExternalAgentProbeRunner`, `externalAgentProbeKey`, `runExternalAgentProbe`, and `runExternalAgentProbeBatch`.

- [ ] **Step 1: Write the failing batch behavior tests**

Create tests that use two deferred runner promises and exact launch specs. Assert that both unique commands have started before either deferred promise resolves, identical specs produce one runner call, and a second batch invocation performs a fresh runner call. Assert the full returned map values, not mere presence.

```ts
const pending = runExternalAgentProbeBatch([launchA, launchA, launchB], runner);
await Promise.resolve();
expect(started).toEqual([['tool-a', '--help'], ['tool-b', '--help']]);

resolveA({ stdout: 'a', stderr: '', exitCode: 0 });
resolveB({ stdout: 'b', stderr: '', exitCode: 0 });
expect(await pending).toEqual(
  new Map([
    [externalAgentProbeKey(launchA), { stdout: 'a', stderr: '', exitCode: 0 }],
    [externalAgentProbeKey(launchB), { stdout: 'b', stderr: '', exitCode: 0 }]
  ])
);

await runExternalAgentProbeBatch([launchA], runner);
expect(started).toEqual([
  ['tool-a', '--help'],
  ['tool-b', '--help'],
  ['tool-a', '--help']
]);
```

- [ ] **Step 2: Run the new test and verify RED**

Run:

```bash
bun run scripts/bun-test.ts apps/monad/test/unit/external-agent-probe-batch.test.ts --only-failures
```

Expected: FAIL because `probe-batch.ts` and its exports do not exist.

- [ ] **Step 3: Implement the minimal async runner and batch**

Implement a stable per-request key from `argv`, `cwd`, and sorted launch-specific environment entries. `runExternalAgentProbeBatch` must create one promise per unique key, start all unique runner calls before awaiting them, convert runner rejection to `null`, and return a new `Map` for that invocation.

```ts
export interface ExternalAgentProbeResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type ExternalAgentProbeRunner = (
  launch: ExternalAgentLaunchSpec
) => Promise<ExternalAgentProbeResult>;

export function externalAgentProbeKey(launch: ExternalAgentLaunchSpec): string {
  return JSON.stringify([
    launch.argv,
    launch.cwd,
    Object.entries(launch.env ?? {}).sort(([a], [b]) => a.localeCompare(b))
  ]);
}

export async function runExternalAgentProbeBatch(
  launches: readonly ExternalAgentLaunchSpec[],
  runner: ExternalAgentProbeRunner = runExternalAgentProbe
): Promise<Map<string, ExternalAgentProbeResult | null>> {
  const executions = new Map<string, Promise<ExternalAgentProbeResult | null>>();
  for (const launch of launches) {
    const key = externalAgentProbeKey(launch);
    if (!executions.has(key)) executions.set(key, runner(launch).catch(() => null));
  }
  return new Map(
    await Promise.all([...executions].map(async ([key, result]) => [key, await result] as const))
  );
}
```

Implement `runExternalAgentProbe` with `Bun.spawn`, piped stdout/stderr, a 2,000 ms timer that kills the child and reports `exitCode: null`, and a `finally` block that clears the timer. Merge `process.env` with launch-specific environment only at spawn time; the key must not retain the process environment.

- [ ] **Step 4: Run the batch test and verify GREEN**

Run the Step 2 command. Expected: all new cases PASS with no warnings.

- [ ] **Step 5: Commit Task 1**

```bash
git add apps/monad/src/services/external-agent/probe-batch.ts apps/monad/test/unit/external-agent-probe-batch.test.ts
git commit -m "fix(external-agent): run provider probes asynchronously"
```

---

### Task 2: Async preset assembly and handler integration

**Files:**
- Modify: `apps/monad/src/services/external-agent/index.ts:257-295`
- Modify: `apps/monad/src/handlers/settings/external-agent/index.ts:105-107`
- Modify: `apps/monad/test/unit/external-agent-adapters.test.ts:1215-1245`
- Modify: `apps/monad/test/e2e/external-agent-settings.test.ts:220-260`
- Test: `apps/monad/test/unit/external-agent-preset-probes.test.ts`

**Interfaces:**
- Consumes: `runExternalAgentProbeBatch`, `externalAgentProbeKey`, and `ExternalAgentProbeRunner` from Task 1.
- Produces: `listExternalAgentPresets(probes?, runner?): Promise<ExternalAgentPresetView[]>`.

- [ ] **Step 1: Write failing preset assembly tests**

Register a throwaway adapter whose argument-support and model-options probes use the same launch spec. Inject a runner returning one exact output string that both parsers understand. Assert the full preset projection and one runner call. Invoke the service a second time and assert two total runner calls, proving no cross-request cache. Add cases where the runner rejects, returns `exitCode: null`, returns non-zero, and a parser throws; each must return the exact static fallback projection. Unregister the throwaway adapter in `finally`.

```ts
const first = await listExternalAgentPresets(probes, runner);
const second = await listExternalAgentPresets(probes, runner);
expect(first.find(({ id }) => id === 'async-probe-test')).toEqual(expectedProjectedPreset);
expect(second.find(({ id }) => id === 'async-probe-test')).toEqual(expectedProjectedPreset);
expect(runs).toBe(2);
```

- [ ] **Step 2: Run preset tests and verify RED**

Run:

```bash
bun run scripts/bun-test.ts apps/monad/test/unit/external-agent-preset-probes.test.ts --only-failures
```

Expected: FAIL because `listExternalAgentPresets` is synchronous and has no async runner boundary.

- [ ] **Step 3: Implement async per-request preset assembly**

Build base presets synchronously as today. For each preset, resolve optional support and model probe launches without executing them. Await one `runExternalAgentProbeBatch` over all resolved launches. Parse a result only when `exitCode === 0`; catch parser errors. Use empty reasoning arrays and `adapter.listSupportedModels(agentView)` when no valid result exists. Do not store the batch or returned presets outside the function.

```ts
export async function listExternalAgentPresets(
  probes: BinProbes = defaultBinProbes,
  runner: ExternalAgentProbeRunner = runExternalAgentProbe
): Promise<ExternalAgentPresetView[]> {
  const planned = [...ADAPTERS.values()].map((adapter) => planPreset(adapter, probes));
  const results = await runExternalAgentProbeBatch(
    planned.flatMap(({ launches }) => launches),
    runner
  );
  return planned.map((item) => projectPreset(item, results));
}
```

Keep configured-agent synchronous helpers unchanged; they are outside this fix.

- [ ] **Step 4: Update callers and existing contract tests**

Make the settings handler method async and await the service:

```ts
async listExternalAgentPresets(): Promise<ListExternalAgentPresetsResponse> {
  return { presets: await listExternalAgentPresets() };
}
```

Change the existing adapter unit test to `async` and await `listExternalAgentPresets`. Keep the HTTP controller unchanged because Elysia already accepts the returned promise. Preserve the existing full preset contract assertions in the e2e test.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
bun run scripts/bun-test.ts \
  apps/monad/test/unit/external-agent-probe-batch.test.ts \
  apps/monad/test/unit/external-agent-preset-probes.test.ts \
  apps/monad/test/unit/external-agent-adapters.test.ts \
  apps/monad/test/e2e/external-agent-settings.test.ts \
  --only-failures
```

Expected: all focused tests PASS over both TCP and Unix transport cases.

- [ ] **Step 6: Commit Task 2**

```bash
git add apps/monad/src/services/external-agent/index.ts \
  apps/monad/src/handlers/settings/external-agent/index.ts \
  apps/monad/test/unit/external-agent-adapters.test.ts \
  apps/monad/test/unit/external-agent-preset-probes.test.ts \
  apps/monad/test/e2e/external-agent-settings.test.ts
git commit -m "fix(external-agent): parallelize fresh preset probes"
```

---

### Task 3: Verification and live performance proof

**Files:**
- Verify only; no planned production changes.

**Interfaces:**
- Consumes the async preset endpoint from Task 2.
- Produces evidence that the current response contract and daemon responsiveness are preserved.

- [ ] **Step 1: Run repository checks**

Generate required development artifacts, then run lint, typecheck, and the full test suite sequentially so generated bindings are not removed during a concurrent build.

```bash
bun run scripts/generate-route-tree.ts
bun run scripts/generate-codex-app-server-protocol.ts
bun run lint
bun run typecheck
bun run test
```

Expected: all commands exit 0.

- [ ] **Step 2: Deploy and measure the local instance**

After integration into main, run `bun run deploy:local`. Start one fresh preset request and, while it is pending, issue `/v1/projects/prj_Hp5QxIAdpCg8/sessions` and `/monad-icon-vector-solid.svg`. Record client timing and daemon `durationMs`.

Expected:

- preset total is near the slowest individual provider probe rather than their sum;
- sessions and SVG complete while preset is still pending;
- daemon logs show sessions in low single-digit milliseconds and SVG in 0–1 ms;
- two sequential preset calls each launch provider probe children, proving no cache.

- [ ] **Step 3: Review the diff and commit any verification-only test adjustment**

Run `git diff --check` and inspect every changed test for exact behavior assertions. No commit is needed when verification creates no tracked change.
