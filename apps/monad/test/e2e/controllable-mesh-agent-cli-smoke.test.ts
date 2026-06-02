import type { MonadPaths } from '@monad/environment';
import type { SessionId } from '@monad/protocol';
import type { EventBus } from '#/services/event-bus.ts';

import { describe, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinAgentAdapters } from '@monad/atoms/agent-adapters';
import { initMonadHome, loadAuth, loadConfig } from '@monad/environment';

import { ModelService } from '#/handlers/settings/model/index.ts';
import { registerAgentAdapterImpl } from '#/services/mesh-agent/index.ts';
import { createHttpTransport } from '#/transports/http.ts';
import { writeControllableMeshAgentCli } from '../fixtures/controllable-mesh-agent-cli.ts';
import {
  buildHandlers,
  makeTestPaths,
  mockModel,
  seededProviderRegistry,
  serveTransport,
  TRANSPORTS
} from '../helpers.ts';

for (const adapter of builtinAgentAdapters) registerAgentAdapterImpl(adapter);

type Call = (method: string, path: string, body?: unknown) => Promise<Response>;

async function setup(): Promise<{
  dir: string;
  projectDir: string;
  app: ReturnType<typeof createHttpTransport>;
  handlers: ReturnType<typeof buildHandlers>;
}> {
  const dir = join(
    tmpdir(),
    `monad-controllable-mesh-agent-cli-${process.pid}-${Date.now()}-${process.hrtime.bigint()}`
  );
  const projectDir = join(dir, 'project');
  await mkdir(projectDir, { recursive: true });
  const paths: MonadPaths = makeTestPaths(dir);
  await initMonadHome(paths);
  const cfg = await loadConfig(paths);
  if (!cfg) throw new Error('config missing after init');
  const modelService = new ModelService(paths.auth, cfg, await loadAuth(paths.auth), seededProviderRegistry());
  const handlers = buildHandlers(mockModel(), { paths, modelService }, { sessionDeleteGraceMs: 5 });
  return { dir, projectDir, handlers, app: createHttpTransport(handlers) };
}

const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body)
});

async function waitFor<T>(read: () => T | undefined, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await Bun.sleep(25);
  }
  throw new Error('timed out waiting for condition');
}

/** `mesh.session.connection.closed` is `transient` (event-table.ts) — it is never persisted and
 *  never replayed, so the subscription MUST be established before the action that triggers it
 *  (process exit/kill), not polled for afterward. Fires exactly when a MeshAgent session's
 *  process activation closes (session-event-runtime-launcher.ts), which is the same moment `pid`
 *  returns to null — the signal Opus identified in review. */
function waitForConnectionClosed(
  bus: EventBus,
  sessionId: SessionId,
  meshSessionId: string,
  timeoutMs = 2_000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error('timed out waiting for mesh.session.connection.closed'));
    }, timeoutMs);
    const unsubscribe = bus.subscribe(sessionId, (event) => {
      if (event.type !== 'mesh.session.connection.closed') return;
      if ((event.payload as { meshSessionId: string }).meshSessionId !== meshSessionId) return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}

/** No daemon event marks "providerSessionRef was just persisted" (connection.opened fires at
 *  process spawn, before the init frame is even decoded — see the earlier investigation). Rather
 *  than poll, wrap the exact store call the daemon makes when it persists the ref
 *  (`store.updateMeshSessionRef`, called from session-event-runtime-launcher.ts's `consumeEvent`
 *  on a decoded `provider_session_identified` event) and resolve once real code calls it for the
 *  target mesh session — this waits on the actual happens-before, through the real decoder/store
 *  path, not a proxy for it. Restores the original method in the caller's `finally`. */
function waitForProviderSessionRefPersisted(
  handlers: { store: { updateMeshSessionRef(id: string, providerSessionRef: string): boolean } },
  meshSessionId: string,
  timeoutMs = 2_000
): { result: Promise<string>; restore: () => void } {
  const original = handlers.store.updateMeshSessionRef.bind(handlers.store);
  let resolve!: (ref: string) => void;
  let reject!: (error: Error) => void;
  const result = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const timer = setTimeout(() => reject(new Error('timed out waiting for providerSessionRef to persist')), timeoutMs);
  handlers.store.updateMeshSessionRef = (id: string, providerSessionRef: string): boolean => {
    const persisted = original(id, providerSessionRef);
    if (id === meshSessionId) {
      clearTimeout(timer);
      resolve(providerSessionRef);
    }
    return persisted;
  };
  return {
    result,
    restore: () => {
      handlers.store.updateMeshSessionRef = original;
    }
  };
}

async function createSession(call: Call, cwd: string): Promise<SessionId> {
  const response = await call('POST', '/v1/sessions', { title: 'controllable session-event runtime', cwd });
  expect(response.status).toBe(201);
  return ((await response.json()) as { sessionId: SessionId }).sessionId;
}

async function configureAgent(call: Call, name: string, script: string): Promise<void> {
  const response = await call('PUT', `/v1/mesh/agents/${name}`, {
    agent: {
      name,
      provider: 'claude-code',
      command: script,
      args: [],
      enabled: true,
      allowAutopilot: false,
      approvalOwnership: 'provider-owned'
    }
  });
  expect(response.status).toBe(200);
}

for (const kind of TRANSPORTS) {
  describe.skipIf(process.platform === 'win32')(`controllable mesh-agent CLI over ${kind}`, () => {
    test('non-zero provider exit is reflected as a failed turn, not a clean stop', async () => {
      const { dir, projectDir, app, handlers } = await setup();
      const transport = serveTransport(kind, app);
      const call: Call = (method, path, body) => transport.fetch(path, jsonInit(method, body));
      try {
        const script = await writeControllableMeshAgentCli(dir, { sessionRef: 'ref-nonzero', exitCode: 7 });
        await configureAgent(call, 'nonzero-cli', script);
        const sessionId = await createSession(call, projectDir);
        const started = await call('POST', '/v1/mesh/sessions', {
          transcriptTargetId: sessionId,
          agentName: 'nonzero-cli',
          workingPath: projectDir
        });
        expect(started.status).toBe(200);
        const meshSession = ((await started.json()) as { session: { id: string } }).session;

        const input = await call('POST', `/v1/mesh/sessions/${meshSession.id}/input?transcriptTargetId=${sessionId}`, {
          input: 'trigger a failing turn'
        });
        expect(input.status).toBe(200);

        const settled = await waitFor(() => {
          const row = handlers.store.getMeshSession(meshSession.id);
          return row?.providerSessionRef === 'ref-nonzero' && row.pid === null && row.state === 'failed'
            ? row
            : undefined;
        });
        expect({ state: settled?.state, providerSessionRef: settled?.providerSessionRef, pid: settled?.pid }).toEqual({
          state: 'failed',
          providerSessionRef: 'ref-nonzero',
          pid: null
        });
      } finally {
        await transport.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('a turn killed mid-flight keeps its providerSessionRef and settles to a terminal state', async () => {
      const { dir, projectDir, app, handlers } = await setup();
      const transport = serveTransport(kind, app);
      const call: Call = (method, path, body) => transport.fetch(path, jsonInit(method, body));
      try {
        const script = await writeControllableMeshAgentCli(dir, { sessionRef: 'ref-midflight', hangAfterInit: true });
        await configureAgent(call, 'hang-cli', script);
        const sessionId = await createSession(call, projectDir);
        const started = await call('POST', '/v1/mesh/sessions', {
          transcriptTargetId: sessionId,
          agentName: 'hang-cli',
          workingPath: projectDir
        });
        expect(started.status).toBe(200);
        const meshSession = ((await started.json()) as { session: { id: string } }).session;

        // `/input` blocks until the turn settles, so it must not be awaited before the process is
        // killed — fire it, wait for connection.closed (subscribed up front, since it's transient
        // and won't replay), kill the process, then await both settling together.
        const closed = waitForConnectionClosed(handlers.bus, sessionId, meshSession.id);
        const providerSessionRefPersisted = waitForProviderSessionRefPersisted(handlers, meshSession.id);
        const inputPromise = call('POST', `/v1/mesh/sessions/${meshSession.id}/input?transcriptTargetId=${sessionId}`, {
          input: 'trigger a turn that never completes'
        }).catch((error: Error) => error);

        try {
          const persistedRef = await providerSessionRefPersisted.result;
          expect(persistedRef).toBe('ref-midflight');
        } finally {
          providerSessionRefPersisted.restore();
        }
        // pid and providerSessionRef are two different write paths (pid via the 'running'-state
        // upsertMeshSession snapshot write; providerSessionRef via updateMeshSessionRef on init
        // decode) but pid's write happens at process-spawn time, strictly before the init frame
        // is even decoded — so pid is already persisted by the time this promise resolves, and
        // this single read (not a poll) is safe.
        const running = handlers.store.getMeshSession(meshSession.id);
        if (running?.pid == null) throw new Error('expected the hung turn to still have a live pid');

        process.kill(running.pid, 'SIGKILL');
        await Promise.all([inputPromise, closed]);

        const settled = handlers.store.getMeshSession(meshSession.id);
        expect({ providerSessionRef: settled?.providerSessionRef, pid: settled?.pid }).toEqual({
          providerSessionRef: 'ref-midflight',
          pid: null
        });
      } finally {
        await transport.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('a provider that crashes with a non-zero code right after init keeps its providerSessionRef', async () => {
      const { dir, projectDir, app, handlers } = await setup();
      const transport = serveTransport(kind, app);
      const call: Call = (method, path, body) => transport.fetch(path, jsonInit(method, body));
      try {
        const script = await writeControllableMeshAgentCli(dir, { sessionRef: 'ref-crash', exitAfterInit: 9 });
        await configureAgent(call, 'crash-cli', script);
        const sessionId = await createSession(call, projectDir);
        const started = await call('POST', '/v1/mesh/sessions', {
          transcriptTargetId: sessionId,
          agentName: 'crash-cli',
          workingPath: projectDir
        });
        expect(started.status).toBe(200);
        const meshSession = ((await started.json()) as { session: { id: string } }).session;

        // Distinct from the mid-flight-kill case above: this is the provider process itself
        // choosing to die with an exit code, with no external signal and no result frame ever
        // sent — the orphan/crash path a daemon restart must reconcile, not a signalled kill.
        const closed = waitForConnectionClosed(handlers.bus, sessionId, meshSession.id);
        const input = await call('POST', `/v1/mesh/sessions/${meshSession.id}/input?transcriptTargetId=${sessionId}`, {
          input: 'trigger a provider self-crash'
        });
        expect(input.status).toBe(200);
        await closed;

        const settled = handlers.store.getMeshSession(meshSession.id);
        expect({ state: settled?.state, providerSessionRef: settled?.providerSessionRef, pid: settled?.pid }).toEqual({
          state: 'failed',
          providerSessionRef: 'ref-crash',
          pid: null
        });
      } finally {
        await transport.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
}
