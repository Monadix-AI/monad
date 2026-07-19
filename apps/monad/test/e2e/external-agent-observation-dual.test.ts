// Observation Dual Stream — Task 4: the daemon HTTP surface for the raw diagnostic plane, the
// convenience projection plane, and the connection handshake. Over BOTH transports (TCP loopback +
// Unix socket) per the all-transports rule in AGENTS.md. These routes are additive alongside the
// legacy observation/ui-observation routes (which stay untouched until a later removal task).

import type {
  ExternalAgentConnectionSnapshot,
  ExternalAgentConvenienceFrame,
  ExternalAgentRawFrame,
  ExternalAgentRawHistoryPage,
  ExternalAgentSessionView,
  SessionId
} from '@monad/protocol';

import { describe, expect, test } from 'bun:test';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinAgentAdapters } from '@monad/atoms/agent-adapters';
import { initMonadHome, loadAuth, loadConfig } from '@monad/environment';

import { ModelService } from '#/handlers/settings/model/index.ts';
import { registerAgentAdapterImpl } from '#/services/external-agent/index.ts';
import { createHttpTransport } from '#/transports/http.ts';
import {
  buildHandlers,
  makeTestPaths,
  mockModel,
  seededProviderRegistry,
  serveTransport,
  TRANSPORTS
} from '../helpers.ts';

// Production populates the external agent registry at boot via the gated atom-pack path; this harness
// builds handlers directly, so register the built-in adapters up front.
for (const adapter of builtinAgentAdapters) registerAgentAdapterImpl(adapter);

type Call = (method: string, path: string, body?: unknown) => Promise<Response>;
type FetchPath = (path: string, init?: RequestInit) => Promise<Response>;

async function setup(): Promise<{
  dir: string;
  projectDir: string;
  app: ReturnType<typeof createHttpTransport>;
  handlers: ReturnType<typeof buildHandlers>;
}> {
  const dir = join(
    process.env.MONAD_HOME ?? tmpdir(),
    `monad-observation-dual-${process.pid}-${Date.now()}-${process.hrtime.bigint()}`
  );
  const projectDir = join(dir, 'project');
  await mkdir(projectDir, { recursive: true });
  const paths = makeTestPaths(dir);
  await initMonadHome(paths);
  const cfg = await loadConfig(paths);
  if (!cfg) throw new Error('config missing after init');
  const modelService = new ModelService(paths.auth, cfg, await loadAuth(paths.auth), seededProviderRegistry());
  const handlers = buildHandlers(mockModel(), { paths, modelService }, { sessionDeleteGraceMs: 5 });
  return { dir, projectDir, app: createHttpTransport(handlers), handlers };
}

async function waitFor<T>(fn: () => T | undefined | Promise<T | undefined>, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value !== undefined) return value;
    await Bun.sleep(25);
  }
  throw new Error('timed out waiting for condition');
}

async function createSession(call: Call, cwd: string): Promise<SessionId> {
  const res = await call('POST', '/v1/sessions', { title: 'observation dual', cwd });
  expect(res.status).toBe(201);
  return ((await res.json()) as { sessionId: SessionId }).sessionId;
}

async function configureJsonStreamAgent(call: Call, dir: string): Promise<void> {
  const script = join(dir, 'mock-claude-json.js');
  await writeFile(
    script,
    [
      '#!/usr/bin/env bun',
      'process.stdout.write(JSON.stringify({type:"system", subtype:"init", session_id:"claude-session-1", cwd:process.cwd()}) + "\\n");',
      'process.stdout.write(JSON.stringify({type:"assistant", session_id:"claude-session-1", message:{role:"assistant", content:[{type:"text", text:"ready-json"}]}}) + "\\n");',
      'process.stdin.on("data", (d) => {',
      '  const text = d.toString().trim().split(/\\n+/).map((line) => JSON.parse(line).message.content[0].text).join("\\n");',
      '  process.stdout.write(JSON.stringify({type:"assistant", session_id:"claude-session-1", message:{role:"assistant", content:[{type:"text", text:"echo-json:" + text}]}}) + "\\n");',
      '});',
      'setInterval(() => {}, 1000);'
    ].join('\n')
  );
  await chmod(script, 0o755);
  const res = await call('PUT', '/v1/settings/external-agents/mock-claude-json', {
    agent: {
      name: 'mock-claude-json',
      provider: 'claude-code',
      command: script,
      args: [],
      enabled: true,
      defaultLaunchMode: 'json-stream',
      allowAutopilot: false,
      approvalOwnership: 'provider-owned'
    }
  });
  expect(res.status).toBe(200);
}

async function configureCodexAppServerAgent(call: Call, dir: string): Promise<void> {
  const script = join(dir, 'mock-codex-app-server.js');
  await writeFile(
    script,
    [
      '#!/usr/bin/env bun',
      'process.stdin.on("data", (d) => {',
      '  for (const line of d.toString().trim().split(/\\n+/)) {',
      '    if (!line) continue;',
      '    const msg = JSON.parse(line);',
      '    if (msg.method === "initialize") { process.stdout.write(JSON.stringify({id:msg.id, result:{userAgent:"mock"}}) + "\\n"); continue; }',
      '    if (msg.method === "initialized") continue;',
      '    if (msg.method === "thread/start" || msg.method === "thread/resume") {',
      '      process.stdout.write(JSON.stringify({id:msg.id, result:{thread:{id:"codex-thread-1"}}}) + "\\n");',
      '    }',
      '    if (msg.method === "thread/turns/list") {',
      '      process.stdout.write(JSON.stringify({id:msg.id, result:{data:[{id:"turn_1", items:[]}], nextCursor:"next_cursor", backwardsCursor:null}}) + "\\n");',
      '    }',
      '  }',
      '});',
      'setInterval(() => {}, 1000);'
    ].join('\n')
  );
  await chmod(script, 0o755);
  const res = await call('PUT', '/v1/settings/external-agents/mock-codex-app-server', {
    agent: {
      name: 'mock-codex-app-server',
      provider: 'codex',
      command: script,
      args: [],
      enabled: true,
      defaultLaunchMode: 'app-server',
      allowAutopilot: false,
      approvalOwnership: 'provider-owned'
    }
  });
  expect(res.status).toBe(200);
}

async function readSse<T>(
  fetchPath: FetchPath,
  path: string,
  until: (frame: T) => boolean,
  timeoutMs = 3_000
): Promise<T[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const seen: T[] = [];
  try {
    const res = await fetchPath(path, { headers: { accept: 'text/event-stream' }, signal: controller.signal });
    const reader = res.body?.getReader();
    if (!reader) return seen;
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return seen;
      buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let sep = buf.indexOf('\n\n');
      while (sep !== -1) {
        const frameText = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const dataLine = frameText.split('\n').find((l) => l.startsWith('data: '));
        if (dataLine) {
          const frame = JSON.parse(dataLine.slice(6)) as T;
          seen.push(frame);
          if (until(frame)) return seen;
        }
        sep = buf.indexOf('\n\n');
      }
    }
  } catch {
    // aborted (timeout or satisfied) — return what was collected
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return seen;
}

for (const kind of TRANSPORTS) {
  describe(`external agent observation dual stream over ${kind}`, () => {
    async function startJsonStreamSession(): Promise<{
      call: Call;
      fetchPath: FetchPath;
      stop: () => Promise<void>;
      sessionId: SessionId;
      nativeSession: ExternalAgentSessionView;
      handlers: ReturnType<typeof buildHandlers>;
    }> {
      const { dir, projectDir, app, handlers } = await setup();
      const t = serveTransport(kind, app);
      const call: Call = (method, path, body) =>
        t.fetch(path, {
          method,
          headers: { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body)
        });
      const fetchPath: FetchPath = (path, init) => t.fetch(path, init);
      await configureJsonStreamAgent(call, dir);
      const sessionId = await createSession(call, projectDir);
      const res = await call('POST', `/v1/sessions/${sessionId}/external-agents/start`, {
        agentName: 'mock-claude-json',
        workingPath: projectDir,
        launchMode: 'json-stream'
      });
      expect(res.status).toBe(200);
      const nativeSession = ((await res.json()) as { session: ExternalAgentSessionView }).session;
      await waitFor(() => {
        const row = handlers.store.getExternalAgentSession(nativeSession.id);
        return row?.providerSessionRef === 'claude-session-1' ? row : undefined;
      });
      return { call, fetchPath, stop: () => t.stop(), sessionId, nativeSession, handlers };
    }

    test('history/raw returns a page of exact provider-native records with coverage', async () => {
      const { dir, projectDir, app, handlers } = await setup();
      const t = serveTransport(kind, app);
      const call: Call = (method, path, body) =>
        t.fetch(path, {
          method,
          headers: { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body)
        });
      try {
        await configureCodexAppServerAgent(call, dir);
        const sessionId = await createSession(call, projectDir);
        const start = await call('POST', `/v1/sessions/${sessionId}/external-agents/start`, {
          agentName: 'mock-codex-app-server',
          workingPath: projectDir,
          launchMode: 'app-server'
        });
        expect(start.status).toBe(200);
        const nativeSession = ((await start.json()) as { session: ExternalAgentSessionView }).session;
        await waitFor(() => {
          const row = handlers.store.getExternalAgentSession(nativeSession.id);
          return row?.providerSessionRef === 'codex-thread-1' ? row : undefined;
        });

        const res = await call(
          'GET',
          `/v1/external-agent-sessions/${nativeSession.id}/history/raw?transcriptTargetId=${sessionId}&limit=5&sortDirection=desc`
        );
        expect(res.status).toBe(200);
        const page = (await res.json()) as ExternalAgentRawHistoryPage;
        expect({
          coverage: page.coverage,
          nextCursor: page.nextCursor,
          records: page.records.map((record) => record.data)
        }).toEqual({
          coverage: 'exact',
          nextCursor: 'next_cursor',
          records: [{ id: 'turn_1', items: [] }]
        });

        await call('POST', `/v1/external-agent-sessions/${nativeSession.id}/stop?transcriptTargetId=${sessionId}`);
      } finally {
        await t.stop();
      }
    });

    test('connection returns a connected snapshot with epoch and a monotonic revision', async () => {
      const { call, stop, sessionId, nativeSession } = await startJsonStreamSession();
      try {
        const res = await call(
          'GET',
          `/v1/external-agent-sessions/${nativeSession.id}/connection?transcriptTargetId=${sessionId}`
        );
        expect(res.status).toBe(200);
        const snapshot = (await res.json()) as ExternalAgentConnectionSnapshot;
        expect(snapshot.state).toBe('connected');
        if (snapshot.state !== 'connected') throw new Error('expected connected snapshot');
        expect(snapshot.externalAgentSessionId).toBe(nativeSession.id);
        expect(snapshot.provider).toBe('claude-code');
        expect(snapshot.observationEpoch.length).toBeGreaterThan(0);
        expect(Number.isInteger(snapshot.revision) && snapshot.revision >= 0).toBe(true);
      } finally {
        await stop();
      }
    });

    test('stream/raw delivers verbatim provider frames including a reply to input', async () => {
      const { call, fetchPath, stop, sessionId, nativeSession } = await startJsonStreamSession();
      try {
        const framesPromise = readSse<ExternalAgentRawFrame>(
          fetchPath,
          `/v1/external-agent-sessions/${nativeSession.id}/stream/raw?transcriptTargetId=${sessionId}`,
          (frame) => typeof frame.data === 'string' && frame.data.includes('echo-json:hi-raw')
        );
        await Bun.sleep(50);
        const input = await call(
          'POST',
          `/v1/external-agent-sessions/${nativeSession.id}/input?transcriptTargetId=${sessionId}`,
          { input: 'hi-raw' }
        );
        expect(input.status).toBe(200);

        const frames = await framesPromise;
        // The startup frame is preserved byte-for-byte (raw plane never normalizes `data`).
        const ready = frames.find((f) => typeof f.data === 'string' && f.data.includes('ready-json'));
        expect(ready).toMatchObject({
          externalAgentSessionId: nativeSession.id,
          provider: 'claude-code',
          origin: 'live'
        });
        expect(typeof ready?.cursor).toBe('string');
        const echo = frames.find((f) => typeof f.data === 'string' && f.data.includes('echo-json:hi-raw'));
        expect(echo).toMatchObject({ provider: 'claude-code', origin: 'live' });
      } finally {
        await stop();
      }
    });

    test('stream/convenience opens with a ready frame then upserts neutral events', async () => {
      const { fetchPath, stop, sessionId, nativeSession } = await startJsonStreamSession();
      try {
        const frames = await readSse<ExternalAgentConvenienceFrame>(
          fetchPath,
          `/v1/external-agent-sessions/${nativeSession.id}/stream/convenience?transcriptTargetId=${sessionId}`,
          (frame) =>
            frame.kind === 'upsert' &&
            frame.event.kind === 'assistant-message' &&
            typeof frame.event.text === 'string' &&
            frame.event.text.includes('ready-json')
        );
        expect(frames[0]?.kind).toBe('ready');
        const upsert = frames.find(
          (f): f is Extract<ExternalAgentConvenienceFrame, { kind: 'upsert' }> =>
            f.kind === 'upsert' &&
            f.event.kind === 'assistant-message' &&
            typeof f.event.text === 'string' &&
            f.event.text.includes('ready-json')
        );
        expect(upsert?.event).toMatchObject({ kind: 'assistant-message' });
        expect(upsert?.cursor).toBe(upsert?.event.id);
      } finally {
        await stop();
      }
    });
  });
}
