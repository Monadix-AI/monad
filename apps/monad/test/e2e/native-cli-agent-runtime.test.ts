import type { MonadPaths } from '@monad/home';
import type { DeveloperLogRecord, NativeCliAuthSessionView, NativeCliSessionView, SessionId } from '@monad/protocol';

import { describe, expect, test } from 'bun:test';
import { chmod, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { initMonadHome, loadAuth, loadConfig } from '@monad/home';
import { setLogLevel } from '@monad/logger';

import { ModelService } from '@/handlers/settings/model/index.ts';
import { createHttpTransport } from '@/transports/http.ts';
import {
  buildHandlers,
  makeTestPaths,
  mockModel,
  seededProviderRegistry,
  serveTransport,
  TRANSPORTS
} from '../helpers.ts';

type Call = (method: string, path: string, body?: unknown) => Promise<Response>;
type FetchPath = (path: string, init?: RequestInit) => Promise<Response>;

interface DeveloperLogStream {
  connected: Promise<void>;
  done: Promise<DeveloperLogRecord[]>;
  seen: DeveloperLogRecord[];
  stop(): void;
}

function makePaths(base: string): MonadPaths {
  return makeTestPaths(base);
}

async function setup(): Promise<{
  dir: string;
  projectDir: string;
  app: ReturnType<typeof createHttpTransport>;
  handlers: ReturnType<typeof buildHandlers>;
}> {
  const dir = join(tmpdir(), `monad-native-cli-runtime-${process.pid}-${Date.now()}-${process.hrtime.bigint()}`);
  const projectDir = join(dir, 'project');
  await mkdir(projectDir, { recursive: true });
  const paths = makePaths(dir);
  await initMonadHome(paths);
  const cfg = await loadConfig(paths.config);
  if (!cfg) throw new Error('config missing after init');
  setLogLevel('debug');
  const modelService = new ModelService(paths.auth, cfg, await loadAuth(paths.auth), seededProviderRegistry());
  const handlers = buildHandlers(mockModel(), { paths, modelService });
  const app = createHttpTransport(handlers);
  return { dir, projectDir, app, handlers };
}

function streamSessionLogs(
  fetchPath: FetchPath,
  sessionId: SessionId,
  until: (record: DeveloperLogRecord) => boolean,
  timeoutMs = 2_000
): DeveloperLogStream {
  const controller = new AbortController();
  const seen: DeveloperLogRecord[] = [];
  let resolveConnected: () => void = () => {};
  const connected = new Promise<void>((resolve) => {
    resolveConnected = resolve;
  });

  const done = (async () => {
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchPath(`/v1/sessions/${sessionId}/logs`, {
        headers: { accept: 'text/event-stream' },
        signal: controller.signal
      });
      resolveConnected();
      if (!res.ok) throw new Error(`logs stream failed with ${res.status}`);
      const reader = res.body?.getReader();
      if (!reader) return seen;
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let sep = buf.indexOf('\n\n');
        while (sep !== -1) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
          if (dataLine) {
            const record = JSON.parse(dataLine.slice(6)) as DeveloperLogRecord;
            seen.push(record);
            if (until(record)) {
              controller.abort();
              return seen;
            }
          }
          sep = buf.indexOf('\n\n');
        }
      }
    } catch {
      return seen;
    } finally {
      clearTimeout(timer);
      resolveConnected();
    }
    return seen;
  })();

  return {
    connected,
    done,
    seen,
    stop: () => controller.abort()
  };
}

const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body)
});

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
  const res = await call('POST', '/v1/sessions', {
    title: 'native cli runtime',
    cwd
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { sessionId: SessionId }).sessionId;
}

async function configureMockAgent(call: Call): Promise<void> {
  const res = await call('PUT', '/v1/settings/native-cli-agents', {
    agent: {
      name: 'mock-cli',
      provider: 'claude-code',
      command: 'bun',
      args: [
        '-e',
        'process.stdout.write("ready\\n"); process.stdin.on("data", (d) => process.stdout.write("echo:" + d)); setInterval(() => {}, 1000);'
      ],
      enabled: true,
      defaultLaunchMode: 'pty',
      allowDangerousMode: false,
      approvalOwnership: 'provider-owned'
    }
  });
  expect(res.status).toBe(200);
}

async function configureMockJsonStreamAgent(call: Call, dir: string): Promise<void> {
  const script = join(dir, 'mock-claude-json.js');
  await writeFile(
    script,
    [
      '#!/usr/bin/env bun',
      'const init = JSON.stringify({type:"system", subtype:"init", session_id:"claude-session-1", cwd:process.cwd()}) + "\\n";',
      'process.stdout.write(init.slice(0, Math.floor(init.length / 2)));',
      'setTimeout(() => {',
      '  process.stdout.write(init.slice(Math.floor(init.length / 2)));',
      '  process.stdout.write(JSON.stringify({type:"assistant", session_id:"claude-session-1", message:{role:"assistant", content:[{type:"text", text:"ready-json"}]}}) + "\\n");',
      '  process.stderr.write("stderr-json\\n");',
      '}, 25);',
      'process.stdin.on("data", (d) => {',
      '  const text = d.toString().trim().split(/\\n+/).map((line) => JSON.parse(line).message.content[0].text).join("\\n");',
      '  process.stdout.write(JSON.stringify({type:"assistant", session_id:"claude-session-1", message:{role:"assistant", content:[{type:"text", text:"echo-json:" + text}]}}) + "\\n");',
      '});',
      'setInterval(() => {}, 1000);'
    ].join('\n')
  );
  await chmod(script, 0o755);
  const res = await call('PUT', '/v1/settings/native-cli-agents', {
    agent: {
      name: 'mock-claude-json',
      provider: 'claude-code',
      command: script,
      args: [],
      enabled: true,
      defaultLaunchMode: 'json-stream',
      allowDangerousMode: false,
      approvalOwnership: 'provider-owned'
    }
  });
  expect(res.status).toBe(200);
}

async function configureMockCodexApprovalAgent(call: Call, dir: string): Promise<void> {
  const script = join(dir, 'mock-codex-approval.js');
  const stdinLog = join(dir, 'mock-codex-stdin.jsonl');
  await writeFile(
    script,
    [
      '#!/usr/bin/env bun',
      'import { appendFileSync } from "node:fs";',
      `const stdinLog = ${JSON.stringify(stdinLog)};`,
      'process.stdin.on("data", (d) => {',
      '  appendFileSync(stdinLog, d.toString());',
      '  for (const line of d.toString().trim().split(/\\n+/)) {',
      '    if (!line) continue;',
      '    const msg = JSON.parse(line);',
      '    if (msg.method === "thread/start" || msg.method === "thread/resume") {',
      '      process.stdout.write(JSON.stringify({id:msg.id, result:{thread:{id:"codex-thread-1"}}}) + "\\n");',
      '      const request = JSON.stringify({method:"item/commandExecution/requestApproval", id:"req_provider_1", params:{threadId:"thr_1", turnId:"turn_1", itemId:"item_1", startedAtMs:1790610000000, environmentId:"env_1", reason:"network access", command:"curl https://example.com", cwd:process.cwd()}}) + "\\n";',
      '      setTimeout(() => {',
      '        process.stdout.write(request.slice(0, 18));',
      '        setTimeout(() => {',
      '          process.stdout.write(request.slice(18));',
      '        }, 25);',
      '      }, 25);',
      '    }',
      '    if (msg.method === "thread/turns/list") {',
      '      process.stdout.write(JSON.stringify({id:msg.id, result:{data:[{id:"turn_1", items:[]}], nextCursor:"next_cursor", backwardsCursor:null}}) + "\\n");',
      '    }',
      '    if (msg.id === "req_provider_1") process.stdout.write(JSON.stringify({method:"serverRequest/resolved", params:{threadId:"thr_1", requestId:"req_provider_1"}}) + "\\n");',
      '  }',
      '});',
      'setInterval(() => {}, 1000);'
    ].join('\n')
  );
  await chmod(script, 0o755);
  const res = await call('PUT', '/v1/settings/native-cli-agents', {
    agent: {
      name: 'mock-codex-approval',
      provider: 'codex',
      command: script,
      args: [],
      enabled: true,
      defaultLaunchMode: 'app-server',
      allowDangerousMode: false,
      approvalOwnership: 'provider-owned'
    }
  });
  expect(res.status).toBe(200);
  return;
}

async function configureMockCodexOversizedLineAgent(call: Call, dir: string): Promise<void> {
  const script = join(dir, 'mock-codex-oversized-line.js');
  await writeFile(
    script,
    [
      '#!/usr/bin/env bun',
      'process.stdin.on("data", (d) => {',
      '  for (const line of d.toString().trim().split(/\\n+/)) {',
      '    if (!line) continue;',
      '    const msg = JSON.parse(line);',
      '    if (msg.method !== "thread/start" && msg.method !== "thread/resume") continue;',
      '    process.stdout.write(JSON.stringify({method:"thread/status/changed", params:{threadId:"codex-thread-light", status:{type:"idle"}}}) + "\\n");',
      '    process.stdout.write("{\\"huge\\":\\"" + "x".repeat(3 * 1024 * 1024));',
      '    setTimeout(() => {',
      '      process.stdout.write("\\"}\\n");',
      '      process.stdout.write(JSON.stringify({method:"item/commandExecution/requestApproval", id:"req_after_huge", params:{threadId:"codex-thread-light", turnId:"turn_1", itemId:"item_1", startedAtMs:1790610000000, reason:"after huge line", command:"echo ok", cwd:process.cwd()}}) + "\\n");',
      '    }, 25);',
      '  }',
      '});',
      'setInterval(() => {}, 1000);'
    ].join('\n')
  );
  await chmod(script, 0o755);
  const res = await call('PUT', '/v1/settings/native-cli-agents', {
    agent: {
      name: 'mock-codex-oversized-line',
      provider: 'codex',
      command: script,
      args: [],
      enabled: true,
      defaultLaunchMode: 'app-server',
      allowDangerousMode: false,
      approvalOwnership: 'provider-owned'
    }
  });
  expect(res.status).toBe(200);
}

async function configureMockAuthAgent(call: Call, dir: string): Promise<void> {
  const script = join(dir, 'mock-native-auth.js');
  await writeFile(
    script,
    [
      '#!/usr/bin/env bun',
      'const args = process.argv.slice(2).join(" ");',
      'if (args === "auth status") {',
      '  process.stdout.write(JSON.stringify({ state: "authenticated" }) + "\\n");',
      '  process.exit(0);',
      '}',
      'if (args === "auth login") {',
      '  process.stdout.write("Open https://provider.example/login and enter code ABCD\\n");',
      '  process.stdin.on("data", (d) => process.stdout.write("auth-input:" + d));',
      '  setInterval(() => {}, 1000);',
      '}'
    ].join('\n')
  );
  await chmod(script, 0o755);
  const res = await call('PUT', '/v1/settings/native-cli-agents', {
    agent: {
      name: 'mock-native-auth',
      provider: 'claude-code',
      command: script,
      args: [],
      enabled: true,
      defaultLaunchMode: 'pty',
      allowDangerousMode: false,
      approvalOwnership: 'provider-owned'
    }
  });
  expect(res.status).toBe(200);
}

async function configureHangingAuthStatusAgent(call: Call, dir: string): Promise<void> {
  const script = join(dir, 'mock-hanging-auth-status.js');
  await writeFile(
    script,
    [
      '#!/usr/bin/env bun',
      'const args = process.argv.slice(2).join(" ");',
      'if (args === "auth status") setInterval(() => {}, 1000);'
    ].join('\n')
  );
  await chmod(script, 0o755);
  const res = await call('PUT', '/v1/settings/native-cli-agents', {
    agent: {
      name: 'mock-hanging-auth-status',
      provider: 'claude-code',
      command: script,
      args: [],
      enabled: true,
      defaultLaunchMode: 'pty',
      allowDangerousMode: false,
      approvalOwnership: 'provider-owned'
    }
  });
  expect(res.status).toBe(200);
}

async function configureMissingBinaryAgent(call: Call): Promise<void> {
  const res = await call('PUT', '/v1/settings/native-cli-agents', {
    agent: {
      name: 'missing-cli',
      provider: 'claude-code',
      command: '/definitely/not/a/native-cli-provider',
      args: [],
      enabled: true,
      defaultLaunchMode: 'json-stream',
      allowDangerousMode: false,
      approvalOwnership: 'provider-owned'
    }
  });
  expect(res.status).toBe(200);
}

async function runRuntime(call: Call, projectDir: string, handlers: ReturnType<typeof buildHandlers>): Promise<void> {
  await configureMockAgent(call);
  const sessionId = await createSession(call, projectDir);

  let res = await call('POST', `/v1/sessions/${sessionId}/native-cli-agents/start`, {
    agentName: 'mock-cli',
    workingPath: projectDir,
    launchMode: 'pty'
  });
  expect(res.status).toBe(200);
  const nativeSession = ((await res.json()) as { session: NativeCliSessionView }).session;
  expect(nativeSession.provider).toBe('claude-code');
  expect(nativeSession.workingPath).toBe(await realpath(projectDir));
  expect(nativeSession.state).toBe('running');
  expect(await Bun.file(join(dirname(projectDir), 'native-cli-processes.json')).exists()).toBe(true);

  res = await call('GET', `/v1/native-cli-sessions/${nativeSession.id}`);
  expect(res.status).toBe(200);
  expect(((await res.json()) as { session: NativeCliSessionView }).session.id).toBe(nativeSession.id);

  res = await call('GET', `/v1/sessions/${sessionId}/native-cli-sessions`);
  expect(res.status).toBe(200);
  expect(((await res.json()) as { sessions: NativeCliSessionView[] }).sessions.map((s) => s.id)).toContain(
    nativeSession.id
  );

  await waitFor(() => {
    const row = handlers.store.getNativeCliSession(nativeSession.id);
    return row?.outputSnapshot.includes('ready') ? row : undefined;
  });

  res = await call('POST', `/v1/native-cli-sessions/${nativeSession.id}/input`, { input: 'hello\n' });
  expect(res.status).toBe(200);
  await waitFor(() => {
    const row = handlers.store.getNativeCliSession(nativeSession.id);
    return row?.outputSnapshot.includes('echo:hello') ? row : undefined;
  });

  res = await call('POST', `/v1/native-cli-sessions/${nativeSession.id}/resize`, { cols: 120, rows: 40 });
  expect(res.status).toBe(200);

  res = await call('POST', `/v1/native-cli-sessions/${nativeSession.id}/stop`);
  expect(res.status).toBe(200);
  const stopped = await waitFor(() => {
    const row = handlers.store.getNativeCliSession(nativeSession.id);
    return row?.state === 'stopped' ? row : undefined;
  });
  expect(stopped.exitCode).toBeNull();
  await waitFor(async () =>
    (await Bun.file(join(dirname(projectDir), 'native-cli-processes.json')).exists()) ? undefined : true
  );
}

async function startMockNativeCliSession(
  call: Call,
  projectDir: string
): Promise<{ sessionId: SessionId; nativeSession: NativeCliSessionView }> {
  await configureMockAgent(call);
  const sessionId = await createSession(call, projectDir);
  const res = await call('POST', `/v1/sessions/${sessionId}/native-cli-agents/start`, {
    agentName: 'mock-cli',
    workingPath: projectDir,
    launchMode: 'pty'
  });
  expect(res.status).toBe(200);
  return { sessionId, nativeSession: ((await res.json()) as { session: NativeCliSessionView }).session };
}

async function runSessionResetStopsNativeCliRuntime(
  call: Call,
  projectDir: string,
  handlers: ReturnType<typeof buildHandlers>
): Promise<void> {
  const { sessionId, nativeSession } = await startMockNativeCliSession(call, projectDir);
  await waitFor(() => {
    const row = handlers.store.getNativeCliSession(nativeSession.id);
    return row?.outputSnapshot.includes('ready') ? row : undefined;
  });

  const reset = await call('POST', `/v1/sessions/${sessionId}/reset`);
  expect(reset.status).toBe(200);

  const stopped = await waitFor(() => {
    const row = handlers.store.getNativeCliSession(nativeSession.id);
    return row?.state === 'stopped' ? row : undefined;
  });
  expect(stopped.exitCode).toBeNull();
  await waitFor(async () =>
    (await Bun.file(join(dirname(projectDir), 'native-cli-processes.json')).exists()) ? undefined : true
  );
}

async function runSessionDeleteStopsNativeCliRuntime(
  call: Call,
  projectDir: string,
  handlers: ReturnType<typeof buildHandlers>
): Promise<void> {
  const { sessionId, nativeSession } = await startMockNativeCliSession(call, projectDir);
  await waitFor(() => {
    const row = handlers.store.getNativeCliSession(nativeSession.id);
    return row?.outputSnapshot.includes('ready') ? row : undefined;
  });

  const deleted = await call('DELETE', `/v1/sessions/${sessionId}`);
  expect(deleted.status).toBe(200);

  await waitFor(async () =>
    (await Bun.file(join(dirname(projectDir), 'native-cli-processes.json')).exists()) ? undefined : true
  );
  expect(handlers.store.getNativeCliSession(nativeSession.id)).toBeNull();
}

async function runWorkingPathRealpathRuntime(call: Call, dir: string, projectDir: string): Promise<void> {
  await configureMockAgent(call);
  const linkDir = join(dir, 'project-link');
  await symlink(projectDir, linkDir, 'dir');
  const sessionId = await createSession(call, projectDir);

  const res = await call('POST', `/v1/sessions/${sessionId}/native-cli-agents/start`, {
    agentName: 'mock-cli',
    workingPath: linkDir,
    launchMode: 'pty'
  });
  expect(res.status).toBe(200);
  const nativeSession = ((await res.json()) as { session: NativeCliSessionView }).session;
  expect(nativeSession.workingPath).toBe(await realpath(projectDir));

  await call('POST', `/v1/native-cli-sessions/${nativeSession.id}/stop`);
}

async function runWorkingPathBoundaryRuntime(call: Call, dir: string, projectDir: string): Promise<void> {
  await configureMockAgent(call);
  const outsideDir = join(dir, 'outside-project');
  await mkdir(outsideDir, { recursive: true });
  const sessionId = await createSession(call, projectDir);

  const res = await call('POST', `/v1/sessions/${sessionId}/native-cli-agents/start`, {
    agentName: 'mock-cli',
    workingPath: outsideDir,
    launchMode: 'pty'
  });
  expect(res.status).toBe(400);
  expect((await res.json()) as { error: string }).toMatchObject({
    error: expect.stringContaining('workingPath must be within the session working directory')
  });
}

async function runJsonStreamRuntime(
  call: Call,
  fetchPath: FetchPath,
  dir: string,
  projectDir: string,
  handlers: ReturnType<typeof buildHandlers>
): Promise<void> {
  await configureMockJsonStreamAgent(call, dir);
  const sessionId = await createSession(call, projectDir);
  const logs = streamSessionLogs(fetchPath, sessionId, (record) => record.event === 'native_cli.stop');
  await logs.connected;

  const res = await call('POST', `/v1/sessions/${sessionId}/native-cli-agents/start`, {
    agentName: 'mock-claude-json',
    workingPath: projectDir,
    launchMode: 'json-stream'
  });
  expect(res.status).toBe(200);
  const nativeSession = ((await res.json()) as { session: NativeCliSessionView }).session;
  expect(nativeSession.provider).toBe('claude-code');
  expect(nativeSession.launchMode).toBe('json-stream');

  await waitFor(() => {
    const row = handlers.store.getNativeCliSession(nativeSession.id);
    return row?.providerSessionRef === 'claude-session-1' &&
      row.outputSnapshot.includes('ready-json') &&
      row.outputSnapshot.includes('stderr-json')
      ? row
      : undefined;
  });

  let events = handlers.store.listEvents(sessionId);
  expect(events.some((event) => event.type === 'native_cli.output')).toBe(true);
  expect(events.some((event) => event.type === 'native_cli.output' && event.payload.stream === 'stderr')).toBe(true);
  await waitFor(() => (logs.seen.some((record) => record.event === 'native_cli.launch') ? true : undefined));

  const input = await call('POST', `/v1/native-cli-sessions/${nativeSession.id}/input`, { input: 'hello-json' });
  expect(input.status).toBe(200);
  await waitFor(() => {
    const row = handlers.store.getNativeCliSession(nativeSession.id);
    return row?.outputSnapshot.includes('echo-json:hello-json') ? row : undefined;
  });
  await waitFor(() => (logs.seen.some((record) => record.event === 'native_cli.input') ? true : undefined));

  const unsupportedHistory = await call('POST', `/v1/native-cli-sessions/${nativeSession.id}/history-page`, {
    limit: 1
  });
  expect(unsupportedHistory.status).toBe(400);
  expect(((await unsupportedHistory.json()) as { code: string }).code).toBe('unsupported_capability');

  const stop = await call('POST', `/v1/native-cli-sessions/${nativeSession.id}/stop`);
  expect(stop.status).toBe(200);
  events = handlers.store.listEvents(sessionId);
  expect(events.some((event) => event.type === 'native_cli.exited')).toBe(true);
  expect((await logs.done).some((record) => record.event === 'native_cli.stop')).toBe(true);
  await Bun.sleep(50);
  expect(handlers.store.getNativeCliSession(nativeSession.id)?.state).toBe('stopped');
}

async function runProviderApprovalRuntime(
  call: Call,
  dir: string,
  projectDir: string,
  handlers: ReturnType<typeof buildHandlers>
): Promise<void> {
  await configureMockCodexApprovalAgent(call, dir);
  const sessionId = await createSession(call, projectDir);

  const res = await call('POST', `/v1/sessions/${sessionId}/native-cli-agents/start`, {
    agentName: 'mock-codex-approval',
    workingPath: projectDir,
    launchMode: 'app-server'
  });
  expect(res.status).toBe(200);
  const nativeSession = ((await res.json()) as { session: NativeCliSessionView }).session;

  await waitFor(() => {
    const events = handlers.store.listEvents(sessionId);
    return events.some((event) => event.type === 'native_cli.approval_requested') &&
      handlers.store.getNativeCliSession(nativeSession.id)?.providerSessionRef === 'codex-thread-1'
      ? events
      : undefined;
  });

  const input = await call('POST', `/v1/native-cli-sessions/${nativeSession.id}/input`, { input: 'summarize' });
  expect(input.status).toBe(200);
  await waitFor(() => {
    const text = Bun.file(join(dir, 'mock-codex-stdin.jsonl'))
      .text()
      .catch(() => '');
    return text.then((value) => (value.includes('summarize') ? true : undefined));
  });
  const stdinLines = (await readFile(join(dir, 'mock-codex-stdin.jsonl'), 'utf8'))
    .trim()
    .split(/\n+/)
    .map((line) => JSON.parse(line) as { id?: number | string; method?: string; params?: Record<string, unknown> });
  expect(stdinLines.some((line) => line.method === 'initialize')).toBe(true);
  expect(stdinLines.some((line) => line.method === 'initialized')).toBe(true);
  expect(stdinLines.some((line) => line.method === 'thread/start')).toBe(true);
  expect(
    stdinLines.some(
      (line) =>
        line.method === 'turn/start' &&
        typeof line.id === 'number' &&
        line.id >= 2 &&
        line.params?.threadId === 'codex-thread-1' &&
        JSON.stringify(line.params?.input).includes('summarize')
    )
  ).toBe(true);

  const events = handlers.store.listEvents(sessionId);
  const requested = events.find((event) => event.type === 'native_cli.approval_requested');
  expect(requested?.payload.provider).toBe('codex');
  expect(requested?.payload.requestId).toBe('req_provider_1');
  expect(String(requested?.payload.text)).toContain('curl https://example.com');
  expect(events.some((event) => event.type === 'tool.approval_requested')).toBe(false);

  const approval = await call('POST', `/v1/native-cli-sessions/${nativeSession.id}/approval`, {
    requestId: 'req_provider_1',
    allow: true,
    reason: 'approved in test'
  });
  expect(approval.status).toBe(200);
  await waitFor(() => {
    const events = handlers.store.listEvents(sessionId);
    return events.some(
      (event) =>
        event.type === 'native_cli.approval_resolved' &&
        event.payload.requestId === 'req_provider_1' &&
        event.payload.allow === true
    )
      ? events
      : undefined;
  });
  const stdinAfterApproval = (await readFile(join(dir, 'mock-codex-stdin.jsonl'), 'utf8'))
    .trim()
    .split(/\n+/)
    .map((line) => JSON.parse(line) as { id?: string; result?: Record<string, unknown> });
  expect(stdinAfterApproval.some((line) => line.id === 'req_provider_1' && line.result?.decision === 'accept')).toBe(
    true
  );

  const stop = await call('POST', `/v1/native-cli-sessions/${nativeSession.id}/stop`);
  expect(stop.status).toBe(200);
}

async function runCodexResumeRuntime(call: Call, dir: string, projectDir: string): Promise<void> {
  await configureMockCodexApprovalAgent(call, dir);
  const sessionId = await createSession(call, projectDir);

  const res = await call('POST', `/v1/sessions/${sessionId}/native-cli-agents/start`, {
    agentName: 'mock-codex-approval',
    workingPath: projectDir,
    launchMode: 'app-server',
    providerSessionRef: 'codex-thread-resume'
  });
  expect(res.status).toBe(200);
  const nativeSession = ((await res.json()) as { session: NativeCliSessionView }).session;
  expect(nativeSession.providerSessionRef).toBe('codex-thread-resume');

  await waitFor(() => {
    const raw = Bun.file(join(dir, 'mock-codex-stdin.jsonl'));
    return raw.size > 0 ? true : undefined;
  });
  const stdinLines = (await readFile(join(dir, 'mock-codex-stdin.jsonl'), 'utf8'))
    .trim()
    .split(/\n+/)
    .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
  expect(stdinLines.some((line) => line.method === 'thread/start')).toBe(false);
  expect(stdinLines.find((line) => line.method === 'initialize')?.params?.capabilities).toEqual({
    experimentalApi: true
  });
  expect(
    stdinLines.some(
      (line) =>
        line.method === 'thread/resume' &&
        line.params?.threadId === 'codex-thread-resume' &&
        line.params?.cwd === (nativeSession.workingPath as string) &&
        line.params?.excludeTurns === true &&
        JSON.stringify(line.params?.initialTurnsPage) ===
          JSON.stringify({ limit: 20, sortDirection: 'desc', itemsView: 'summary' })
    )
  ).toBe(true);

  await call('POST', `/v1/native-cli-sessions/${nativeSession.id}/stop`);
}

async function runCodexOversizedStructuredLineRuntime(
  call: Call,
  dir: string,
  projectDir: string,
  handlers: ReturnType<typeof buildHandlers>
): Promise<void> {
  await configureMockCodexOversizedLineAgent(call, dir);
  const sessionId = await createSession(call, projectDir);

  const res = await call('POST', `/v1/sessions/${sessionId}/native-cli-agents/start`, {
    agentName: 'mock-codex-oversized-line',
    workingPath: projectDir,
    launchMode: 'app-server'
  });
  expect(res.status).toBe(200);
  const nativeSession = ((await res.json()) as { session: NativeCliSessionView }).session;

  await waitFor(() => {
    const row = handlers.store.getNativeCliSession(nativeSession.id);
    const events = handlers.store.listEvents(sessionId);
    return row?.providerSessionRef === 'codex-thread-light' &&
      events.some(
        (event) => event.type === 'native_cli.approval_requested' && event.payload.requestId === 'req_after_huge'
      )
      ? row
      : undefined;
  });
  const row = handlers.store.getNativeCliSession(nativeSession.id);
  expect(row?.outputSnapshot.length).toBeLessThanOrEqual(256 * 1024);

  await call('POST', `/v1/native-cli-sessions/${nativeSession.id}/stop`);
}

async function runAuthRelayRuntime(call: Call, dir: string, handlers: ReturnType<typeof buildHandlers>): Promise<void> {
  await configureMockAuthAgent(call, dir);

  let res = await call('POST', '/v1/native-cli-agents/mock-native-auth/auth/start');
  expect(res.status).toBe(200);
  const authSession = ((await res.json()) as { session: NativeCliAuthSessionView }).session;
  expect(authSession.id.startsWith('ncliauth_')).toBe(true);
  expect(authSession.provider).toBe('claude-code');
  expect(authSession.authState).toBe('unknown');
  expect(await Bun.file(join(dir, 'native-cli-auth-processes.json')).exists()).toBe(true);

  await waitFor(async () => {
    const current = await call('GET', `/v1/native-cli-auth-sessions/${authSession.id}`);
    const body = (await current.json()) as { session: NativeCliAuthSessionView };
    return body.session.outputSnapshot.includes('provider.example/login') ? body.session : undefined;
  });

  res = await call('POST', `/v1/native-cli-auth-sessions/${authSession.id}/input`, { input: '1234\n' });
  expect(res.status).toBe(200);
  await waitFor(async () => {
    const current = await call('GET', `/v1/native-cli-auth-sessions/${authSession.id}`);
    const body = (await current.json()) as { session: NativeCliAuthSessionView };
    return body.session.outputSnapshot.includes('auth-input:1234') ? body.session : undefined;
  });

  res = await call('POST', `/v1/native-cli-auth-sessions/${authSession.id}/resize`, { cols: 90, rows: 24 });
  expect(res.status).toBe(200);

  res = await call('GET', '/v1/native-cli-agents/mock-native-auth/auth/status');
  expect(res.status).toBe(200);
  expect(((await res.json()) as { state: string }).state).toBe('authenticated');

  expect(handlers.store.listNativeCliSessionsForProject('ses_UNKNOWN')).toHaveLength(0);

  res = await call('POST', `/v1/native-cli-auth-sessions/${authSession.id}/stop`);
  expect(res.status).toBe(200);
  const stopped = await call('GET', `/v1/native-cli-auth-sessions/${authSession.id}`);
  expect(((await stopped.json()) as { session: NativeCliAuthSessionView }).session.state).toBe('stopped');
  await waitFor(async () =>
    (await Bun.file(join(dir, 'native-cli-auth-processes.json')).exists()) ? undefined : true
  );
}

async function runAuthStatusTimeoutRuntime(call: Call, dir: string): Promise<void> {
  await configureHangingAuthStatusAgent(call, dir);

  const res = await call('GET', '/v1/native-cli-agents/mock-hanging-auth-status/auth/status');
  expect(res.status).toBe(502);
  expect(((await res.json()) as { code: string }).code).toBe('provider_timeout');
}

async function runCodexHistoryPageRuntime(
  call: Call,
  dir: string,
  projectDir: string,
  handlers: ReturnType<typeof buildHandlers>
): Promise<void> {
  await configureMockCodexApprovalAgent(call, dir);
  const sessionId = await createSession(call, projectDir);

  const res = await call('POST', `/v1/sessions/${sessionId}/native-cli-agents/start`, {
    agentName: 'mock-codex-approval',
    workingPath: projectDir,
    launchMode: 'app-server'
  });
  expect(res.status).toBe(200);
  const nativeSession = ((await res.json()) as { session: NativeCliSessionView }).session;
  await waitFor(() => {
    const row = handlers.store.getNativeCliSession(nativeSession.id);
    return row?.providerSessionRef === 'codex-thread-1' ? row : undefined;
  });

  const page = await call('POST', `/v1/native-cli-sessions/${nativeSession.id}/history-page`, {
    limit: 1,
    itemsView: 'summary',
    sortDirection: 'desc'
  });
  expect(page.status).toBe(200);
  expect(await page.json()).toEqual({
    page: {
      items: [{ id: 'turn_1', items: [] }],
      nextCursor: 'next_cursor',
      backwardsCursor: null
    }
  });

  await call('POST', `/v1/native-cli-sessions/${nativeSession.id}/stop`);
}

async function runSpawnFailureRuntime(
  call: Call,
  projectDir: string,
  handlers: ReturnType<typeof buildHandlers>
): Promise<void> {
  await configureMissingBinaryAgent(call);
  const sessionId = await createSession(call, projectDir);

  const res = await call('POST', `/v1/sessions/${sessionId}/native-cli-agents/start`, {
    agentName: 'missing-cli',
    workingPath: projectDir,
    launchMode: 'json-stream'
  });
  expect(res.status).toBeGreaterThanOrEqual(400);

  const failed = await waitFor(() => {
    const row = handlers.store
      .listNativeCliSessionsForProject(sessionId)
      .find((candidate) => candidate.state === 'failed');
    return row?.outputSnapshot.includes('/definitely/not/a/native-cli-provider') ? row : undefined;
  });
  expect(failed.pid).toBeNull();
  expect(failed.exitedAt).not.toBeNull();
  expect(handlers.store.listEvents(sessionId).some((event) => event.type === 'native_cli.exited')).toBe(true);
}

for (const kind of TRANSPORTS) {
  describe(`native-cli-agent runtime over ${kind}`, () => {
    test('starts a provider-owned CLI session and relays IO', async () => {
      const { dir, projectDir, app, handlers } = await setup();
      const t = serveTransport(kind, app);
      try {
        await runRuntime((m, p, b) => t.fetch(p, jsonInit(m, b)), projectDir, handlers);
      } finally {
        await t.stop();
        for (const row of handlers.store.listNativeCliSessionsForProject('ses_UNKNOWN')) {
          handlers.store.closeNativeCliSession(row.id, new Date().toISOString(), null, 'stopped');
        }
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('stops active native CLI sessions when a project session is reset', async () => {
      const { dir, projectDir, app, handlers } = await setup();
      const t = serveTransport(kind, app);
      try {
        await runSessionResetStopsNativeCliRuntime((m, p, b) => t.fetch(p, jsonInit(m, b)), projectDir, handlers);
      } finally {
        await t.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('stops active native CLI sessions when a project session is deleted', async () => {
      const { dir, projectDir, app, handlers } = await setup();
      const t = serveTransport(kind, app);
      try {
        await runSessionDeleteStopsNativeCliRuntime((m, p, b) => t.fetch(p, jsonInit(m, b)), projectDir, handlers);
      } finally {
        await t.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('normalizes native CLI working paths through realpath', async () => {
      const { dir, projectDir, app } = await setup();
      const t = serveTransport(kind, app);
      try {
        await runWorkingPathRealpathRuntime((m, p, b) => t.fetch(p, jsonInit(m, b)), dir, projectDir);
      } finally {
        await t.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('rejects direct native CLI starts outside the project working path', async () => {
      const { dir, projectDir, app } = await setup();
      const t = serveTransport(kind, app);
      try {
        await runWorkingPathBoundaryRuntime((m, p, b) => t.fetch(p, jsonInit(m, b)), dir, projectDir);
      } finally {
        await t.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('starts a Claude Code style json-stream session and indexes structured output', async () => {
      const { dir, projectDir, app, handlers } = await setup();
      const t = serveTransport(kind, app);
      try {
        await runJsonStreamRuntime((m, p, b) => t.fetch(p, jsonInit(m, b)), t.fetch, dir, projectDir, handlers);
      } finally {
        await t.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('keeps provider-owned approvals separate from Monad tool approvals', async () => {
      const { dir, projectDir, app, handlers } = await setup();
      const t = serveTransport(kind, app);
      try {
        await runProviderApprovalRuntime((m, p, b) => t.fetch(p, jsonInit(m, b)), dir, projectDir, handlers);
      } finally {
        await t.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('resumes a Codex app-server provider session ref', async () => {
      const { dir, projectDir, app } = await setup();
      const t = serveTransport(kind, app);
      try {
        await runCodexResumeRuntime((m, p, b) => t.fetch(p, jsonInit(m, b)), dir, projectDir);
      } finally {
        await t.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('keeps parsing structured app-server events after an oversized provider line', async () => {
      const { dir, projectDir, app, handlers } = await setup();
      const t = serveTransport(kind, app);
      try {
        await runCodexOversizedStructuredLineRuntime(
          (m, p, b) => t.fetch(p, jsonInit(m, b)),
          dir,
          projectDir,
          handlers
        );
      } finally {
        await t.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('loads Codex app-server history through a paged provider request', async () => {
      const { dir, projectDir, app, handlers } = await setup();
      const t = serveTransport(kind, app);
      try {
        await runCodexHistoryPageRuntime((m, p, b) => t.fetch(p, jsonInit(m, b)), dir, projectDir, handlers);
      } finally {
        await t.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('relays provider-owned native CLI auth flows without project session storage', async () => {
      const { dir, app, handlers } = await setup();
      const t = serveTransport(kind, app);
      try {
        await runAuthRelayRuntime((m, p, b) => t.fetch(p, jsonInit(m, b)), dir, handlers);
      } finally {
        await t.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('returns a provider timeout code when native CLI auth status hangs', async () => {
      const { dir, app } = await setup();
      const t = serveTransport(kind, app);
      try {
        await runAuthStatusTimeoutRuntime((m, p, b) => t.fetch(p, jsonInit(m, b)), dir);
      } finally {
        await t.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('records failed native CLI spawns in the lifecycle ledger', async () => {
      const { dir, projectDir, app, handlers } = await setup();
      const t = serveTransport(kind, app);
      try {
        await runSpawnFailureRuntime((m, p, b) => t.fetch(p, jsonInit(m, b)), projectDir, handlers);
      } finally {
        await t.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
}
