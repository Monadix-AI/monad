// Observation Dual Stream — Task 4: the daemon HTTP surface for the raw diagnostic plane, the
// convenience projection plane, and the connection handshake. Over BOTH transports (TCP loopback +
// Unix socket) per the all-transports rule in AGENTS.md. These routes are additive alongside the
// legacy observation/ui-observation routes (which stay untouched until a later removal task).

import type {
  MeshConnectionSnapshot,
  MeshConvenienceFrame,
  MeshRawEvent,
  MeshRawEventPage,
  MeshSessionView,
  SessionId
} from '@monad/protocol';

import { describe, expect, test } from 'bun:test';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinAgentAdapters } from '@monad/atoms/agent-adapters';
import { initMonadHome, loadAuth, loadConfig } from '@monad/environment';
import { parseObservationCursor } from '@monad/protocol';

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

// Production populates the MeshAgent registry at boot via the gated atom-pack path; this harness
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
  const res = await call('PUT', '/v1/mesh/agents/mock-claude-json', {
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
      'const providerCursor = JSON.stringify({turnId:"turn_1", includeAnchor:false});',
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
      '      const older = msg.params?.cursor === providerCursor;',
      '      process.stdout.write(JSON.stringify({id:msg.id, result:{data:[{id:older ? "turn_0" : "turn_1", items:[]}], nextCursor:older ? null : providerCursor, backwardsCursor:null}}) + "\\n");',
      '    }',
      '  }',
      '});',
      'setInterval(() => {}, 1000);'
    ].join('\n')
  );
  await chmod(script, 0o755);
  const res = await call('PUT', '/v1/mesh/agents/mock-codex-app-server', {
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
  timeoutMs = 3_000,
  extraHeaders: Record<string, string> = {}
): Promise<T[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const seen: T[] = [];
  const sseIds: (string | undefined)[] = [];
  try {
    const res = await fetchPath(path, {
      headers: { accept: 'text/event-stream', ...extraHeaders },
      signal: controller.signal
    });
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
        const idLine = frameText.split('\n').find((l) => l.startsWith('id: '));
        if (dataLine) {
          const frame = JSON.parse(dataLine.slice(6)) as T;
          sseIds.push(idLine ? idLine.slice(4) : undefined);
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

/** Same reader, but also returns each frame's SSE `id:` so a test can assert the resume anchor the
 *  client engine would actually pick up. */
async function readSseWithIds<T>(
  fetchPath: FetchPath,
  path: string,
  until: (frame: T) => boolean,
  extraHeaders: Record<string, string> = {}
): Promise<Array<{ frame: T; id?: string }>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  const seen: Array<{ frame: T; id?: string }> = [];
  try {
    const res = await fetchPath(path, {
      headers: { accept: 'text/event-stream', ...extraHeaders },
      signal: controller.signal
    });
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
        const idLine = frameText.split('\n').find((l) => l.startsWith('id: '));
        if (dataLine) {
          const frame = JSON.parse(dataLine.slice(6)) as T;
          seen.push({ frame, ...(idLine ? { id: idLine.slice(4) } : {}) });
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
  describe(`MeshAgent observation dual stream over ${kind}`, () => {
    async function startJsonStreamSession(): Promise<{
      call: Call;
      fetchPath: FetchPath;
      stop: () => Promise<void>;
      sessionId: SessionId;
      nativeSession: MeshSessionView;
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
      const res = await call('POST', '/v1/mesh/sessions', {
        transcriptTargetId: sessionId,
        agentName: 'mock-claude-json',
        workingPath: projectDir,
        launchMode: 'json-stream'
      });
      expect(res.status).toBe(200);
      const nativeSession = ((await res.json()) as { session: MeshSessionView }).session;
      await waitFor(() => {
        const row = handlers.store.getMeshSession(nativeSession.id);
        return row?.providerSessionRef === 'claude-session-1' ? row : undefined;
      });
      return { call, fetchPath, stop: () => t.stop(), sessionId, nativeSession, handlers };
    }

    test('events/raw returns a page of exact provider-native records with coverage', async () => {
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
        const start = await call('POST', '/v1/mesh/sessions', {
          transcriptTargetId: sessionId,
          agentName: 'mock-codex-app-server',
          workingPath: projectDir,
          launchMode: 'app-server'
        });
        expect(start.status).toBe(200);
        const nativeSession = ((await start.json()) as { session: MeshSessionView }).session;
        await waitFor(() => {
          const row = handlers.store.getMeshSession(nativeSession.id);
          return row?.providerSessionRef === 'codex-thread-1' ? row : undefined;
        });

        const res = await call(
          'GET',
          `/v1/mesh/sessions/${nativeSession.id}/events/raw?transcriptTargetId=${sessionId}&limit=5`
        );
        expect(res.status).toBe(200);
        const page = (await res.json()) as MeshRawEventPage;
        expect({
          coverage: page.coverage,
          nextCursor: page.nextCursor,
          records: page.records.map((record) => record.data)
        }).toEqual({
          coverage: 'exact',
          nextCursor: 'provider:%7B%22turnId%22%3A%22turn_1%22%2C%22includeAnchor%22%3Afalse%7D',
          records: [{ id: 'turn_1', items: [] }]
        });

        const older = await call(
          'GET',
          `/v1/mesh/sessions/${nativeSession.id}/events/raw?transcriptTargetId=${sessionId}&limit=5&before=${encodeURIComponent(page.nextCursor as string)}`
        );
        expect({ status: older.status, page: await older.json() }).toEqual({
          status: 200,
          page: {
            coverage: 'exact',
            records: [{ cursor: 'turn_0', providerIdentity: 'turn_0', data: { id: 'turn_0', items: [] } }]
          }
        });

        await call('POST', `/v1/mesh/sessions/${nativeSession.id}/stop?transcriptTargetId=${sessionId}`);
      } finally {
        await t.stop();
      }
    });

    test('connection returns a connected snapshot with epoch and a monotonic revision', async () => {
      const { call, stop, sessionId, nativeSession } = await startJsonStreamSession();
      try {
        const res = await call(
          'GET',
          `/v1/mesh/sessions/${nativeSession.id}/connection?transcriptTargetId=${sessionId}`
        );
        expect(res.status).toBe(200);
        const snapshot = (await res.json()) as MeshConnectionSnapshot;
        expect(snapshot.state).toBe('connected');
        if (snapshot.state !== 'connected') throw new Error('expected connected snapshot');
        expect(snapshot.meshSessionId).toBe(nativeSession.id);
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
        const framesPromise = readSse<MeshRawEvent>(
          fetchPath,
          `/v1/mesh/sessions/${nativeSession.id}/stream/raw?transcriptTargetId=${sessionId}`,
          (frame) => typeof frame.data === 'string' && frame.data.includes('echo-json:hi-raw')
        );
        await Bun.sleep(50);
        const input = await call(
          'POST',
          `/v1/mesh/sessions/${nativeSession.id}/input?transcriptTargetId=${sessionId}`,
          { input: 'hi-raw' }
        );
        expect(input.status).toBe(200);

        const frames = await framesPromise;
        // The startup frame is preserved byte-for-byte (raw plane never normalizes `data`).
        const ready = frames.find((f) => typeof f.data === 'string' && f.data.includes('ready-json'));
        expect(ready).toMatchObject({
          meshSessionId: nativeSession.id,
          provider: 'claude-code',
          origin: 'live'
        });
        expect(parseObservationCursor(ready?.cursor)).toEqual({
          kind: 'live',
          observationEpoch: ready?.observationEpoch as string,
          seq: expect.any(Number)
        });
        const echo = frames.find((f) => typeof f.data === 'string' && f.data.includes('echo-json:hi-raw'));
        expect(echo).toMatchObject({ provider: 'claude-code', origin: 'live' });
      } finally {
        await stop();
      }
    });

    test('stream/convenience opens with a ready frame then atomic patches of neutral events', async () => {
      const { fetchPath, stop, sessionId, nativeSession } = await startJsonStreamSession();
      const hasReadyJson = (frame: MeshConvenienceFrame): boolean =>
        frame.kind === 'patch' &&
        frame.operations.some(
          (operation) =>
            operation.op === 'upsert' &&
            operation.event.kind === 'assistant-message' &&
            typeof operation.event.text === 'string' &&
            operation.event.text.includes('ready-json')
        );
      try {
        const frames = await readSse<MeshConvenienceFrame>(
          fetchPath,
          `/v1/mesh/sessions/${nativeSession.id}/stream/convenience?transcriptTargetId=${sessionId}`,
          hasReadyJson
        );
        const ready = frames[0];
        expect(ready?.kind).toBe('ready');
        const patch = frames.find(
          (f): f is Extract<MeshConvenienceFrame, { kind: 'patch' }> => f.kind === 'patch' && hasReadyJson(f)
        );

        // The cursor is a position in the epoch's raw store — NOT the projected event's identity.
        // Keeping those separate is what lets one patch carry several operations and still resume.
        expect(parseObservationCursor(patch?.cursor)).toEqual({
          kind: 'live',
          observationEpoch: (ready as { observationEpoch: string }).observationEpoch,
          seq: expect.any(Number)
        });
        const eventIds = (patch?.operations ?? []).flatMap((operation) =>
          operation.op === 'upsert' ? [operation.event.id] : []
        );
        expect(eventIds).not.toContain(patch?.cursor);
      } finally {
        await stop();
      }
    });

    test('disconnecting after ready but before the bootstrap patch does not skip that patch on resume', async () => {
      const { fetchPath, stop, sessionId, nativeSession } = await startJsonStreamSession();
      const streamPath = `/v1/mesh/sessions/${nativeSession.id}/stream/convenience?transcriptTargetId=${sessionId}`;
      const carriesReadyJson = (frame: MeshConvenienceFrame): boolean =>
        frame.kind === 'patch' &&
        frame.operations.some(
          (operation) =>
            operation.op === 'upsert' &&
            typeof operation.event.text === 'string' &&
            operation.event.text.includes('ready-json')
        );
      try {
        const [ready] = await readSseWithIds<MeshConvenienceFrame>(
          fetchPath,
          streamPath,
          (frame) => frame.kind === 'ready'
        );
        const resumed = await readSseWithIds<MeshConvenienceFrame>(fetchPath, streamPath, carriesReadyJson, {
          'last-event-id': ready?.id ?? ''
        });

        expect({
          ready: ready?.frame,
          readyId: ready?.id,
          resumed: resumed.map(({ frame, id }) => ({ kind: frame.kind, id, carriesReadyJson: carriesReadyJson(frame) }))
        }).toEqual({
          ready: {
            kind: 'ready',
            observationEpoch: ready?.frame.kind === 'ready' ? ready.frame.observationEpoch : undefined,
            cursor: `live:${ready?.frame.kind === 'ready' ? ready.frame.observationEpoch : undefined}:0`,
            eventsBefore: 'provider:'
          },
          readyId: `live:${ready?.frame.kind === 'ready' ? ready.frame.observationEpoch : undefined}:0`,
          resumed: [
            {
              kind: 'ready',
              id: `live:${ready?.frame.kind === 'ready' ? ready.frame.observationEpoch : undefined}:0`,
              carriesReadyJson: false
            },
            {
              kind: 'patch',
              id: resumed.at(-1)?.id,
              carriesReadyJson: true
            }
          ]
        });
      } finally {
        await stop();
      }
    });

    test('an in-stream epoch rotation emits a new ready anchor before the new epoch patch', async () => {
      const { call, fetchPath, stop, sessionId, nativeSession } = await startJsonStreamSession();
      const streamPath = `/v1/mesh/sessions/${nativeSession.id}/stream/convenience?transcriptTargetId=${sessionId}`;
      let readyCount = 0;
      try {
        const reading = readSseWithIds<MeshConvenienceFrame>(fetchPath, streamPath, (frame) => {
          if (frame.kind === 'ready') readyCount += 1;
          return readyCount === 2;
        });
        await Bun.sleep(50);
        expect(
          (
            await call('POST', `/v1/mesh/sessions/${nativeSession.id}/input?transcriptTargetId=${sessionId}`, {
              input: 'rotate-observation-epoch'
            })
          ).status
        ).toBe(200);

        const readyFrames = (await reading).filter(
          (entry): entry is { frame: Extract<MeshConvenienceFrame, { kind: 'ready' }>; id?: string } =>
            entry.frame.kind === 'ready'
        );
        expect(
          readyFrames.map(({ frame, id }) => ({
            observationEpoch: frame.observationEpoch,
            cursor: frame.cursor,
            sseId: id
          }))
        ).toEqual([
          {
            observationEpoch: readyFrames[0]?.frame.observationEpoch,
            cursor: `live:${readyFrames[0]?.frame.observationEpoch}:0`,
            sseId: `live:${readyFrames[0]?.frame.observationEpoch}:0`
          },
          {
            observationEpoch: readyFrames[1]?.frame.observationEpoch,
            cursor: `live:${readyFrames[1]?.frame.observationEpoch}:0`,
            sseId: `live:${readyFrames[1]?.frame.observationEpoch}:0`
          }
        ]);
        expect(readyFrames[1]?.frame.observationEpoch).not.toBe(readyFrames[0]?.frame.observationEpoch);
      } finally {
        await stop();
      }
    });

    // Regression 1 — same-epoch resume. The client engine threads its last position back on every
    // reconnect; until the server read it, a reconnect silently replayed the epoch from the start
    // while the client contract advertised resume.
    test('stream/raw resumes after a cursor instead of replaying the epoch', async () => {
      const { call, fetchPath, stop, sessionId, nativeSession } = await startJsonStreamSession();
      const streamPath = `/v1/mesh/sessions/${nativeSession.id}/stream/raw?transcriptTargetId=${sessionId}`;
      const isReady = (f: MeshRawEvent): boolean => typeof f.data === 'string' && f.data.includes('ready-json');
      const carries = (text: string) => (f: MeshRawEvent) => typeof f.data === 'string' && f.data.includes(text);
      const send = async (input: string): Promise<number> =>
        (
          await call('POST', `/v1/mesh/sessions/${nativeSession.id}/input?transcriptTargetId=${sessionId}`, {
            input
          })
        ).status;
      try {
        // The FIRST input checkpoints provider events and rotates to a clean live epoch
        // (prepareObservationEpoch), so any cursor taken before it is stale by construction. Warm
        // that up first — this case is about resuming WITHIN a settled epoch.
        const warmup = readSse<MeshRawEvent>(fetchPath, streamPath, carries('echo-json:warmup'));
        await Bun.sleep(50);
        expect(await send('warmup')).toBe(200);
        await warmup;

        const first = await readSse<MeshRawEvent>(fetchPath, streamPath, carries('echo-json:warmup'));
        const resumeAt = first.at(-1)?.cursor as string;
        const resumeSeq = parseObservationCursor(resumeAt) as { seq: number };

        const echoed = readSse<MeshRawEvent>(
          fetchPath,
          `${streamPath}&after=${encodeURIComponent(resumeAt)}`,
          (f) => typeof f.data === 'string' && f.data.includes('echo-json:hi-resume')
        );
        await Bun.sleep(50);
        expect(await send('hi-resume')).toBe(200);

        const resumed = await echoed;
        expect(resumed.some((f) => typeof f.data === 'string' && f.data.includes('echo-json:hi-resume'))).toBe(true);
        // Nothing at or before the resume position is re-delivered.
        expect(resumed.filter(isReady)).toEqual([]);
        const positions = resumed.map((f) => parseObservationCursor(f.cursor));
        expect(positions.every((p) => p?.kind === 'live' && p.seq > resumeSeq.seq)).toBe(true);
      } finally {
        await stop();
      }
    });

    // Regression 2 — a cursor from a rotated epoch must not be read as a sequence in the current one
    // (that would skip its opening frames). It replays, and the anchor the client picks up must be
    // the NEW epoch's: without an SSE `id:` on that first frame the client would keep re-sending the
    // dead cursor on every reconnect forever.
    test('a rotated-epoch cursor replays the current epoch and re-anchors the client', async () => {
      const { fetchPath, stop, sessionId, nativeSession } = await startJsonStreamSession();
      const isReady = (f: MeshRawEvent): boolean => typeof f.data === 'string' && f.data.includes('ready-json');
      try {
        const replayed = await readSseWithIds<MeshRawEvent>(
          fetchPath,
          `/v1/mesh/sessions/${nativeSession.id}/stream/raw?transcriptTargetId=${sessionId}`,
          isReady,
          { 'last-event-id': 'live:oep_rotated_away:9999' }
        );

        const ready = replayed.find((entry) => isReady(entry.frame));
        expect(replayed.filter((entry) => isReady(entry.frame)).length).toBe(1);
        expect(parseObservationCursor(ready?.id)).toEqual({
          kind: 'live',
          observationEpoch: ready?.frame.observationEpoch as string,
          seq: expect.any(Number)
        });
        expect(ready?.id).not.toBe('live:oep_rotated_away:9999');
      } finally {
        await stop();
      }
    });

    // Regression 3 — the reason the patch is atomic. One raw position can project to several
    // operations; a consumer that drops mid-batch and resumes at `> cursor` must not lose the
    // batch's remainder. Comparing an interrupted read against an uninterrupted one is what proves
    // the delivery unit, not the operation, is what a cursor advances past.
    test('a multi-operation position loses nothing across a mid-stream disconnect', async () => {
      const { call, fetchPath, stop, sessionId, nativeSession } = await startJsonStreamSession();
      const streamPath = `/v1/mesh/sessions/${nativeSession.id}/stream/convenience?transcriptTargetId=${sessionId}`;
      const carries = (frame: MeshConvenienceFrame, text: string): boolean =>
        frame.kind === 'patch' &&
        frame.operations.some(
          (operation) =>
            operation.op === 'upsert' && typeof operation.event.text === 'string' && operation.event.text.includes(text)
        );
      const eventsOf = (frames: MeshConvenienceFrame[]): string[] =>
        frames
          .flatMap((frame) => (frame.kind === 'patch' ? frame.operations : []))
          .flatMap((operation) => (operation.op === 'upsert' ? [operation.event.id] : []));
      try {
        const opening = await readSse<MeshConvenienceFrame>(fetchPath, streamPath, (f) => carries(f, 'ready-json'));
        const anchor = opening.find((f) => f.kind === 'patch')?.cursor as string;

        // Drop here, then drive more work while nobody is attached.
        expect(
          (
            await call('POST', `/v1/mesh/sessions/${nativeSession.id}/input?transcriptTargetId=${sessionId}`, {
              input: 'hi-batch'
            })
          ).status
        ).toBe(200);
        await Bun.sleep(100);

        const resumed = await readSse<MeshConvenienceFrame>(
          fetchPath,
          `${streamPath}&after=${encodeURIComponent(anchor)}`,
          (f) => carries(f, 'echo-json:hi-batch')
        );
        const uninterrupted = await readSse<MeshConvenienceFrame>(fetchPath, streamPath, (f) =>
          carries(f, 'echo-json:hi-batch')
        );

        // Everything produced during the gap arrives on resume, and the resumed view of the session
        // is the same set of entities an uninterrupted consumer holds.
        expect(resumed.some((f) => carries(f, 'echo-json:hi-batch'))).toBe(true);
        expect(new Set(eventsOf(resumed))).toEqual(new Set(eventsOf(uninterrupted)));
      } finally {
        await stop();
      }
    });
  });
}
