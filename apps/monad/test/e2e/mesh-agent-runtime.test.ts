import type { MonadPaths } from '@monad/environment';
import type { MeshAgentAuthSessionView, MeshSessionView, SessionId } from '@monad/protocol';

import { describe, expect, test } from 'bun:test';
import { chmod, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinAgentAdapters } from '@monad/atoms/agent-adapters';
import { initMonadHome, loadAuth, loadConfig } from '@monad/environment';

import { ModelService } from '#/handlers/settings/model/index.ts';
import { registerAgentAdapterImpl } from '#/services/mesh-agent/index.ts';
import { createHttpTransport } from '#/transports/http.ts';
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

function makePaths(base: string): MonadPaths {
  return makeTestPaths(base);
}

async function setup(): Promise<{
  dir: string;
  projectDir: string;
  app: ReturnType<typeof createHttpTransport>;
  handlers: ReturnType<typeof buildHandlers>;
}> {
  const dir = join(tmpdir(), `monad-mesh-agent-runtime-${process.pid}-${Date.now()}-${process.hrtime.bigint()}`);
  const projectDir = join(dir, 'project');
  await mkdir(projectDir, { recursive: true });
  const paths = makePaths(dir);
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

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(25);
  }
  throw new Error('timed out waiting for condition');
}

async function createSession(call: Call, cwd: string): Promise<SessionId> {
  const response = await call('POST', '/v1/sessions', { title: 'session-event runtime', cwd });
  expect(response.status).toBe(201);
  return ((await response.json()) as { sessionId: SessionId }).sessionId;
}

async function configureSessionEventAgent(call: Call, dir: string): Promise<void> {
  const script = join(dir, 'mock-session-event-cli.js');
  await writeFile(
    script,
    [
      '#!/usr/bin/env bun',
      'const args = process.argv.slice(2).join(" ");',
      'if (args === "auth status --json") { process.stdout.write(JSON.stringify({ state: "authenticated" }) + "\\n"); process.exit(0); }',
      'let input = "";',
      'process.stdin.on("data", (chunk) => { input += chunk.toString(); });',
      'process.stdin.on("end", () => {',
      '  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "mock-session-1", cwd: process.cwd() }) + "\\n");',
      '  process.stdout.write(JSON.stringify({ type: "assistant", session_id: "mock-session-1", message: { role: "assistant", content: [{ type: "text", text: "echo:" + input }] } }) + "\\n");',
      '  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "", permission_denials: [] }) + "\\n");',
      '});'
    ].join('\n')
  );
  await chmod(script, 0o755);
  const response = await call('PUT', '/v1/mesh/agents/mock-cli', {
    agent: {
      name: 'mock-cli',
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

async function startSessionEventRuntime(call: Call, dir: string, projectDir: string) {
  await configureSessionEventAgent(call, dir);
  const sessionId = await createSession(call, projectDir);
  const response = await call('POST', '/v1/mesh/sessions', {
    transcriptTargetId: sessionId,
    agentName: 'mock-cli',
    workingPath: projectDir
  });
  expect(response.status).toBe(200);
  return { sessionId, meshSession: ((await response.json()) as { session: MeshSessionView }).session };
}

async function configureMissingBinaryAgent(call: Call): Promise<void> {
  const response = await call('PUT', '/v1/mesh/agents/missing-cli', {
    agent: {
      name: 'missing-cli',
      provider: 'claude-code',
      command: '/definitely/not/a/mesh-agent-provider',
      args: [],
      enabled: true,
      allowAutopilot: false,
      approvalOwnership: 'provider-owned'
    }
  });
  expect(response.status).toBe(200);
}

for (const kind of TRANSPORTS) {
  describe.skipIf(process.platform === 'win32')(`mesh-agent session-event runtime over ${kind}`, () => {
    test('runs a provider event turn and preserves the logical session', async () => {
      const { dir, projectDir, app, handlers } = await setup();
      const transport = serveTransport(kind, app);
      const call: Call = (method, path, body) => transport.fetch(path, jsonInit(method, body));
      try {
        const { sessionId, meshSession } = await startSessionEventRuntime(call, dir, projectDir);
        expect({
          provider: meshSession.provider,
          workingPath: meshSession.workingPath,
          lifecycle: meshSession.lifecycle,
          activity: meshSession.activity,
          connection: meshSession.connection
        }).toEqual({
          provider: 'claude-code',
          workingPath: await realpath(projectDir),
          lifecycle: { state: 'active' },
          activity: { state: 'idle', pid: null, queuedTurnCount: 0 },
          connection: { state: 'inactive' }
        });

        const input = await call('POST', `/v1/mesh/sessions/${meshSession.id}/input?transcriptTargetId=${sessionId}`, {
          input: 'hello session events'
        });
        expect(input.status).toBe(200);
        const completed = handlers.store.getMeshSession(meshSession.id);
        expect({
          providerSessionRef: completed?.providerSessionRef,
          state: completed?.state,
          pid: completed?.pid
        }).toEqual({
          providerSessionRef: 'mock-session-1',
          state: 'running',
          pid: null
        });

        const stop = await call('POST', `/v1/mesh/sessions/${meshSession.id}/stop?transcriptTargetId=${sessionId}`);
        expect(stop.status).toBe(200);
        const stopped = await waitFor(() => {
          const row = handlers.store.getMeshSession(meshSession.id);
          return row?.state === 'stopped' ? row : undefined;
        });
        expect({ state: stopped.state, pid: stopped.pid, exitCode: stopped.exitCode }).toEqual({
          state: 'stopped',
          pid: null,
          exitCode: null
        });
      } finally {
        await transport.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('stops logical MeshAgent sessions when their parent session resets or is deleted', async () => {
      const { dir, projectDir, app, handlers } = await setup();
      const transport = serveTransport(kind, app);
      const call: Call = (method, path, body) => transport.fetch(path, jsonInit(method, body));
      try {
        const resetRuntime = await startSessionEventRuntime(call, dir, projectDir);
        const reset = await call('POST', `/v1/sessions/${resetRuntime.sessionId}/reset`);
        expect(reset.status).toBe(200);
        await waitFor(() =>
          handlers.store.getMeshSession(resetRuntime.meshSession.id)?.state === 'stopped' ? true : undefined
        );

        const deletedRuntime = await startSessionEventRuntime(call, dir, projectDir);
        const deleted = await call('DELETE', `/v1/sessions/${deletedRuntime.sessionId}`);
        expect(deleted.status).toBe(200);
        // presence-ok: deleting the parent session must remove its MeshAgent ledger rows.
        await waitFor(() => (handlers.store.getMeshSession(deletedRuntime.meshSession.id) === null ? true : undefined));
      } finally {
        await transport.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('normalizes and contains MeshAgent working paths', async () => {
      const { dir, projectDir, app } = await setup();
      const transport = serveTransport(kind, app);
      const call: Call = (method, path, body) => transport.fetch(path, jsonInit(method, body));
      try {
        await configureSessionEventAgent(call, dir);
        const projectLink = join(dir, 'project-link');
        await symlink(projectDir, projectLink, 'dir');
        const sessionId = await createSession(call, projectDir);
        const normalized = await call('POST', '/v1/mesh/sessions', {
          transcriptTargetId: sessionId,
          agentName: 'mock-cli',
          workingPath: projectLink
        });
        expect(normalized.status).toBe(200);
        const normalizedSession = ((await normalized.json()) as { session: MeshSessionView }).session;
        expect(normalizedSession.workingPath).toBe(await realpath(projectDir));

        const outside = join(dir, 'outside');
        await mkdir(outside);
        const rejected = await call('POST', '/v1/mesh/sessions', {
          transcriptTargetId: sessionId,
          agentName: 'mock-cli',
          workingPath: outside
        });
        expect(rejected.status).toBe(400);
        expect(await rejected.json()).toEqual({
          error: `workingPath must be within the project working directory: ${projectDir}`,
          code: 'VALIDATION'
        });
        await call('POST', `/v1/mesh/sessions/${normalizedSession.id}/stop?transcriptTargetId=${sessionId}`);
      } finally {
        await transport.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('keeps PTY limited to provider authentication', async () => {
      const { dir, app } = await setup();
      const transport = serveTransport(kind, app);
      const call: Call = (method, path, body) => transport.fetch(path, jsonInit(method, body));
      try {
        await configureSessionEventAgent(call, dir);
        const response = await call('POST', '/v1/mesh/agents/mock-cli/auth/start');
        expect(response.status).toBe(200);
        const session = ((await response.json()) as { session: MeshAgentAuthSessionView }).session;
        expect({
          provider: session.provider,
          authState: session.authState,
          state: session.state,
          pid: session.pid
        }).toEqual({
          provider: 'claude-code',
          authState: 'authenticated',
          state: 'exited',
          pid: 0
        });
      } finally {
        await transport.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('records executable resolution failures as failed lifecycle entries', async () => {
      const { dir, projectDir, app, handlers } = await setup();
      const transport = serveTransport(kind, app);
      const call: Call = (method, path, body) => transport.fetch(path, jsonInit(method, body));
      try {
        await configureMissingBinaryAgent(call);
        const sessionId = await createSession(call, projectDir);
        const response = await call('POST', '/v1/mesh/sessions', {
          transcriptTargetId: sessionId,
          agentName: 'missing-cli',
          workingPath: projectDir
        });
        expect(response.status).toBe(500);
        const [failed] = handlers.store.listMeshSessionsForTranscriptTarget(sessionId);
        expect({ state: failed?.state, pid: failed?.pid, hasExitedAt: Boolean(failed?.exitedAt) }).toEqual({
          state: 'failed',
          pid: null,
          hasExitedAt: true
        });
        expect(
          handlers.store
            .listEvents(sessionId)
            .filter((event) => event.type === 'mesh.exited')
            .map((event) => ({ type: event.type, state: event.payload.state }))
        ).toEqual([{ type: 'mesh.exited', state: 'failed' }]);
      } finally {
        await transport.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
}
