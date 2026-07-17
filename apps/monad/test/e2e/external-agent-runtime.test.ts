import type { MonadPaths } from '@monad/environment';
import type {
  DeveloperLogRecord,
  ExternalAgentAuthSessionView,
  ExternalAgentSessionView,
  SessionId,
  SessionUiEvent
} from '@monad/protocol';

import { describe, expect, test } from 'bun:test';
import { chmod, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { builtinAgentAdapters } from '@monad/atoms/agent-adapters';
import { initMonadHome, loadAuth, loadConfig } from '@monad/environment';
import { setLogLevel } from '@monad/logger';

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

// Production populates the external agent registry at boot via the gated atom-pack path
// (onAgentAdapter → registerAgentAdapterImpl); this harness builds handlers directly, so register the
// built-in adapters up front.
for (const adapter of builtinAgentAdapters) registerAgentAdapterImpl(adapter);

type Call = (method: string, path: string, body?: unknown) => Promise<Response>;
type FetchPath = (path: string, init?: RequestInit) => Promise<Response>;

interface DeveloperLogStream {
  connected: Promise<void>;
  done: Promise<DeveloperLogRecord[]>;
  seen: DeveloperLogRecord[];
  stop(): void;
}

interface ExternalAgentAuthStream {
  connected: Promise<void>;
  done: Promise<ExternalAgentAuthSessionView[]>;
  seen: ExternalAgentAuthSessionView[];
  stop(): void;
}

function makePaths(base: string): MonadPaths {
  return makeTestPaths(base);
}

async function setup(opts?: {
  externalAgentAuthHeartbeatTimeoutMs?: number;
  externalAgentAuthStatusTimeoutMs?: number;
}): Promise<{
  dir: string;
  projectDir: string;
  app: ReturnType<typeof createHttpTransport>;
  handlers: ReturnType<typeof buildHandlers>;
}> {
  const dir = join(tmpdir(), `monad-external-agent-runtime-${process.pid}-${Date.now()}-${process.hrtime.bigint()}`);
  const projectDir = join(dir, 'project');
  await mkdir(projectDir, { recursive: true });
  const paths = makePaths(dir);
  await initMonadHome(paths);
  const cfg = await loadConfig(paths);
  if (!cfg) throw new Error('config missing after init');
  setLogLevel('debug');
  const modelService = new ModelService(paths.auth, cfg, await loadAuth(paths.auth), seededProviderRegistry());
  const handlers = buildHandlers(mockModel(), { paths, modelService }, { sessionDeleteGraceMs: 5, ...opts });
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

function streamExternalAgentAuth(
  fetchPath: FetchPath,
  id: string,
  controlToken: string,
  until: (session: ExternalAgentAuthSessionView) => boolean,
  timeoutMs = 2_000
): ExternalAgentAuthStream {
  const controller = new AbortController();
  const seen: ExternalAgentAuthSessionView[] = [];
  let resolveConnected: () => void = () => {};
  const connected = new Promise<void>((resolve) => {
    resolveConnected = resolve;
  });

  const done = (async () => {
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchPath(`/v1/external-agent-auth-sessions/${id}/events?controlToken=${controlToken}`, {
        headers: { accept: 'text/event-stream' },
        signal: controller.signal
      });
      resolveConnected();
      if (!res.ok) throw new Error(`external agent auth stream failed with ${res.status}`);
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
            const session = JSON.parse(dataLine.slice(6)) as ExternalAgentAuthSessionView;
            seen.push(session);
            if (until(session)) {
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
const SESSION_DELETE_TEST_TIMEOUT_MS = 5_000;

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
  const res = await call('PUT', '/v1/settings/external-agents/mock-cli', {
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
      allowAutopilot: false,
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
      '    if (msg.method === "initialize") { process.stdout.write(JSON.stringify({id:msg.id, result:{userAgent:"mock"}}) + "\\n"); continue; }',
      '    if (msg.method === "initialized") continue;',
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
      '      if (msg.params && msg.params.cursor && msg.params.cursor !== "next_cursor") {',
      '        process.stdout.write(JSON.stringify({id:msg.id, error:{code:-32600, message:"invalid cursor: " + msg.params.cursor}}) + "\\n");',
      '      } else {',
      '        process.stdout.write(JSON.stringify({id:msg.id, result:{data:[{id:"turn_1", items:[]}], nextCursor:"next_cursor", backwardsCursor:null}}) + "\\n");',
      '      }',
      '    }',
      '    if (msg.id === "req_provider_1") process.stdout.write(JSON.stringify({method:"serverRequest/resolved", params:{threadId:"thr_1", requestId:"req_provider_1"}}) + "\\n");',
      '  }',
      '});',
      'setInterval(() => {}, 1000);'
    ].join('\n')
  );
  await chmod(script, 0o755);
  const res = await call('PUT', '/v1/settings/external-agents/mock-codex-approval', {
    agent: {
      name: 'mock-codex-approval',
      provider: 'codex',
      command: script,
      args: [],
      enabled: true,
      defaultLaunchMode: 'app-server',
      allowAutopilot: true,
      approvalOwnership: 'provider-owned'
    }
  });
  expect(res.status).toBe(200);
  return;
}

async function configureMockSlowCodexAppServerAgent(call: Call, dir: string): Promise<void> {
  const script = join(dir, 'mock-codex-slow-app-server.js');
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
      '    if (msg.method !== "thread/start" && msg.method !== "thread/resume") continue;',
      '    setTimeout(() => {',
      '      process.stdout.write(JSON.stringify({id:msg.id, result:{thread:{id:"codex-thread-slow"}}}) + "\\n");',
      '    }, 1500);',
      '  }',
      '});',
      'setInterval(() => {}, 1000);'
    ].join('\n')
  );
  await chmod(script, 0o755);
  const res = await call('PUT', '/v1/settings/external-agents/mock-codex-slow-app-server', {
    agent: {
      name: 'mock-codex-slow-app-server',
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
      '    if (msg.method === "initialize") { process.stdout.write(JSON.stringify({id:msg.id, result:{userAgent:"mock"}}) + "\\n"); continue; }',
      '    if (msg.method === "initialized") continue;',
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
  const res = await call('PUT', '/v1/settings/external-agents/mock-codex-oversized-line', {
    agent: {
      name: 'mock-codex-oversized-line',
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

async function configureMockAuthAgent(
  call: Call,
  dir: string,
  opts: { initiallyAuthenticated?: boolean; loginAuthenticates?: boolean } = {}
): Promise<void> {
  const script = join(dir, 'mock-native-auth.js');
  const authMarker = join(dir, 'mock-native-authenticated');
  const loginMarker = join(dir, 'mock-native-login-started');
  if (opts.initiallyAuthenticated) await writeFile(authMarker, '1');
  await writeFile(
    script,
    [
      '#!/usr/bin/env bun',
      'import { existsSync, writeFileSync } from "node:fs";',
      `const authMarker = ${JSON.stringify(authMarker)};`,
      `const loginMarker = ${JSON.stringify(loginMarker)};`,
      `const loginAuthenticates = ${JSON.stringify(opts.loginAuthenticates ?? true)};`,
      'const args = process.argv.slice(2).join(" ");',
      'if (args.startsWith("auth status")) {',
      '  process.stdout.write(JSON.stringify({ state: existsSync(authMarker) ? "authenticated" : "unauthenticated" }) + "\\n");',
      '  process.exit(0);',
      '}',
      'if (args.startsWith("auth login")) {',
      '  writeFileSync(loginMarker, "1");',
      '  if (loginAuthenticates) writeFileSync(authMarker, "1");',
      '  process.stdout.write("Open https://provider.example/login and enter code ABCD\\n");',
      '  process.stdin.on("data", (d) => process.stdout.write("auth-input:" + d));',
      '  setInterval(() => {}, 1000);',
      '}'
    ].join('\n')
  );
  await chmod(script, 0o755);
  const res = await call('PUT', '/v1/settings/external-agents/mock-native-auth', {
    agent: {
      name: 'mock-native-auth',
      provider: 'claude-code',
      command: script,
      args: [],
      enabled: true,
      defaultLaunchMode: 'pty',
      allowAutopilot: false,
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
      'if (args.startsWith("auth status")) setInterval(() => {}, 1000);'
    ].join('\n')
  );
  await chmod(script, 0o755);
  const res = await call('PUT', '/v1/settings/external-agents/mock-hanging-auth-status', {
    agent: {
      name: 'mock-hanging-auth-status',
      provider: 'claude-code',
      command: script,
      args: [],
      enabled: true,
      defaultLaunchMode: 'pty',
      allowAutopilot: false,
      approvalOwnership: 'provider-owned'
    }
  });
  expect(res.status).toBe(200);
}

async function configureMissingBinaryAgent(call: Call): Promise<void> {
  const res = await call('PUT', '/v1/settings/external-agents/missing-cli', {
    agent: {
      name: 'missing-cli',
      provider: 'claude-code',
      command: '/definitely/not/a/external-agent-provider',
      args: [],
      enabled: true,
      defaultLaunchMode: 'json-stream',
      allowAutopilot: false,
      approvalOwnership: 'provider-owned'
    }
  });
  expect(res.status).toBe(200);
}

async function runRuntime(call: Call, projectDir: string, handlers: ReturnType<typeof buildHandlers>): Promise<void> {
  await configureMockAgent(call);
  const sessionId = await createSession(call, projectDir);

  let res = await call('POST', `/v1/sessions/${sessionId}/external-agents/start`, {
    agentName: 'mock-cli',
    workingPath: projectDir,
    launchMode: 'pty'
  });
  expect(res.status).toBe(200);
  const nativeSession = ((await res.json()) as { session: ExternalAgentSessionView }).session;
  expect(nativeSession.provider).toBe('claude-code');
  expect(nativeSession.workingPath).toBe(await realpath(projectDir));
  expect(nativeSession.state).toBe('running');
  expect(await Bun.file(join(dirname(projectDir), 'external-agent-processes.json')).exists()).toBe(true);

  res = await call('GET', `/v1/external-agent-sessions/${nativeSession.id}?transcriptTargetId=${sessionId}`);
  expect(res.status).toBe(200);
  expect(((await res.json()) as { session: ExternalAgentSessionView }).session.id).toBe(nativeSession.id);

  res = await call('GET', `/v1/sessions/${sessionId}/external-agent-sessions`);
  expect(res.status).toBe(200);
  expect(((await res.json()) as { sessions: ExternalAgentSessionView[] }).sessions.map((s) => s.id)).toContain(
    nativeSession.id
  );

  await waitFor(() => {
    const row = handlers.store.getExternalAgentSession(nativeSession.id);
    return row?.outputSnapshot.includes('ready') ? row : undefined;
  });

  res = await call(
    'GET',
    `/v1/external-agent-sessions/${nativeSession.id}/ui-observation?transcriptTargetId=${sessionId}`
  );
  expect(res.status).toBe(200);
  const uiFrame = (await res.json()) as {
    state: string;
    seq?: number;
    events: Array<{ kind: string; role?: unknown }>;
  };
  expect(uiFrame.state).toBe('live');
  expect(typeof uiFrame.seq).toBe('number');
  expect(Array.isArray(uiFrame.events)).toBe(true);
  // The neutral plane emits `kind`-tagged events and never leaks the legacy `role`/providerEventType.
  for (const event of uiFrame.events) {
    expect(typeof event.kind).toBe('string');
    expect(event).not.toHaveProperty('role');
  }

  res = await call('POST', `/v1/external-agent-sessions/${nativeSession.id}/input?transcriptTargetId=${sessionId}`, {
    input: 'hello\n'
  });
  expect(res.status).toBe(200);
  await waitFor(() => {
    const row = handlers.store.getExternalAgentSession(nativeSession.id);
    return row?.outputSnapshot.includes('echo:hello') ? row : undefined;
  });

  res = await call('POST', `/v1/external-agent-sessions/${nativeSession.id}/resize?transcriptTargetId=${sessionId}`, {
    cols: 120,
    rows: 40
  });
  expect(res.status).toBe(200);

  res = await call('POST', `/v1/external-agent-sessions/${nativeSession.id}/stop?transcriptTargetId=${sessionId}`);
  expect(res.status).toBe(200);
  const stopped = await waitFor(() => {
    const row = handlers.store.getExternalAgentSession(nativeSession.id);
    return row?.state === 'stopped' ? row : undefined;
  });
  expect(stopped.exitCode).toBeNull();
  await waitFor(
    async () =>
      (await Bun.file(join(dirname(projectDir), 'external-agent-processes.json')).exists()) ? undefined : true,
    2_000
  );
}

async function startMockExternalAgentSession(
  call: Call,
  projectDir: string
): Promise<{ sessionId: SessionId; nativeSession: ExternalAgentSessionView }> {
  await configureMockAgent(call);
  const sessionId = await createSession(call, projectDir);
  const res = await call('POST', `/v1/sessions/${sessionId}/external-agents/start`, {
    agentName: 'mock-cli',
    workingPath: projectDir,
    launchMode: 'pty'
  });
  expect(res.status).toBe(200);
  return { sessionId, nativeSession: ((await res.json()) as { session: ExternalAgentSessionView }).session };
}

async function runInterruptSteerRuntime(
  call: Call,
  projectDir: string,
  handlers: ReturnType<typeof buildHandlers>
): Promise<void> {
  const { sessionId, nativeSession } = await startMockExternalAgentSession(call, projectDir);
  await waitFor(() => {
    const row = handlers.store.getExternalAgentSession(nativeSession.id);
    return row?.outputSnapshot.includes('ready') ? row : undefined;
  });

  // steer is app-server-only; a pty/json-stream provider has no steer hook, so the route exists
  // (not 404) but rejects the request rather than silently succeeding.
  const steer = await call(
    'POST',
    `/v1/external-agent-sessions/${nativeSession.id}/steer?transcriptTargetId=${sessionId}`,
    {
      input: 'and also run the tests'
    }
  );
  expect(steer.status).not.toBe(404);
  expect(steer.status).not.toBe(200);

  // interrupt has no provider hook here either, so it falls back to stopping the session.
  const interrupt = await call(
    'POST',
    `/v1/external-agent-sessions/${nativeSession.id}/interrupt?transcriptTargetId=${sessionId}`
  );
  expect(interrupt.status).toBe(200);
  await waitFor(() => {
    const row = handlers.store.getExternalAgentSession(nativeSession.id);
    return row?.state === 'stopped' ? row : undefined;
  });
}

async function runSessionResetStopsExternalAgentRuntime(
  call: Call,
  projectDir: string,
  handlers: ReturnType<typeof buildHandlers>
): Promise<void> {
  const { sessionId, nativeSession } = await startMockExternalAgentSession(call, projectDir);
  await waitFor(() => {
    const row = handlers.store.getExternalAgentSession(nativeSession.id);
    return row?.outputSnapshot.includes('ready') ? row : undefined;
  });

  const reset = await call('POST', `/v1/sessions/${sessionId}/reset`);
  expect(reset.status).toBe(200);

  const stopped = await waitFor(() => {
    const row = handlers.store.getExternalAgentSession(nativeSession.id);
    return row?.state === 'stopped' ? row : undefined;
  });
  expect(stopped.exitCode).toBeNull();
  await waitFor(
    async () =>
      (await Bun.file(join(dirname(projectDir), 'external-agent-processes.json')).exists()) ? undefined : true,
    2_000
  );
}

async function runSessionDeleteStopsExternalAgentRuntime(
  call: Call,
  projectDir: string,
  handlers: ReturnType<typeof buildHandlers>
): Promise<void> {
  const { sessionId, nativeSession } = await startMockExternalAgentSession(call, projectDir);
  await waitFor(() => {
    const row = handlers.store.getExternalAgentSession(nativeSession.id);
    return row?.outputSnapshot.includes('ready') ? row : undefined;
  });

  const deleted = await call('DELETE', `/v1/sessions/${sessionId}`);
  expect(deleted.status).toBe(200);

  await waitFor(
    async () =>
      (await Bun.file(join(dirname(projectDir), 'external-agent-processes.json')).exists()) ? undefined : true,
    2_000
  );
  expect(handlers.store.getExternalAgentSession(nativeSession.id)).toBeNull();
}

async function runWorkingPathRealpathRuntime(call: Call, dir: string, projectDir: string): Promise<void> {
  await configureMockAgent(call);
  const linkDir = join(dir, 'project-link');
  await symlink(projectDir, linkDir, 'dir');
  const sessionId = await createSession(call, projectDir);

  const res = await call('POST', `/v1/sessions/${sessionId}/external-agents/start`, {
    agentName: 'mock-cli',
    workingPath: linkDir,
    launchMode: 'pty'
  });
  expect(res.status).toBe(200);
  const nativeSession = ((await res.json()) as { session: ExternalAgentSessionView }).session;
  expect(nativeSession.workingPath).toBe(await realpath(projectDir));

  await call('POST', `/v1/external-agent-sessions/${nativeSession.id}/stop?transcriptTargetId=${sessionId}`);
}

async function runWorkingPathBoundaryRuntime(call: Call, dir: string, projectDir: string): Promise<void> {
  await configureMockAgent(call);
  const outsideDir = join(dir, 'outside-project');
  await mkdir(outsideDir, { recursive: true });
  const sessionId = await createSession(call, projectDir);

  const res = await call('POST', `/v1/sessions/${sessionId}/external-agents/start`, {
    agentName: 'mock-cli',
    workingPath: outsideDir,
    launchMode: 'pty'
  });
  expect(res.status).toBe(400);
  expect((await res.json()) as { error: string }).toMatchObject({
    error: expect.stringContaining('workingPath must be within the project working directory')
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
  const logs = streamSessionLogs(fetchPath, sessionId, (record) => record.event === 'external_agent.stop');
  await logs.connected;

  const res = await call('POST', `/v1/sessions/${sessionId}/external-agents/start`, {
    agentName: 'mock-claude-json',
    workingPath: projectDir,
    launchMode: 'json-stream'
  });
  expect(res.status).toBe(200);
  const nativeSession = ((await res.json()) as { session: ExternalAgentSessionView }).session;
  expect(nativeSession.provider).toBe('claude-code');
  expect(nativeSession.launchMode).toBe('json-stream');

  await waitFor(() => {
    const row = handlers.store.getExternalAgentSession(nativeSession.id);
    return row?.providerSessionRef === 'claude-session-1' &&
      row.outputSnapshot.includes('ready-json') &&
      row.outputSnapshot.includes('stderr-json')
      ? row
      : undefined;
  });

  // external_agent.output chunks are delivered live and captured in the bounded output snapshot, but are
  // NOT persisted as durable event rows (one row per chunk would grow the log without bound). The
  // milestone events (started/exited) stay durable.
  let events = handlers.store.listEvents(sessionId);
  expect(events.some((event) => event.type === 'external_agent.output')).toBe(false);
  expect(events.some((event) => event.type === 'external_agent.started')).toBe(true);

  // A fresh UI subscription rebuilds the external agent tool card from the durable snapshot, so the
  // terminal output survives a page refresh even though the per-chunk events aren't persisted. The
  // snapshot is delivered synchronously during subscribe, so it is captured by the time await resolves.
  let hydrated: SessionUiEvent | undefined;
  const sub = await handlers.session.subscribeUi({ sessionId }, (event) => {
    if (!hydrated && event.kind === 'snapshot') hydrated = event;
  });
  sub.dispose();
  if (hydrated?.kind !== 'snapshot') throw new Error('expected hydrated snapshot');
  const card = hydrated.items.find((item) => item.kind === 'tool' && item.id === nativeSession.id);
  if (card?.kind !== 'tool') throw new Error('expected external agent tool card in hydrated snapshot');
  expect(card.tool).toBe('external-agent:claude-code');
  expect(card.output).toContain('ready-json');
  expect(card.output).toContain('stderr-json');
  await waitFor(() => (logs.seen.some((record) => record.event === 'external_agent.launch') ? true : undefined));

  const input = await call(
    'POST',
    `/v1/external-agent-sessions/${nativeSession.id}/input?transcriptTargetId=${sessionId}`,
    { input: 'hello-json' }
  );
  expect(input.status).toBe(200);
  await waitFor(() => {
    const row = handlers.store.getExternalAgentSession(nativeSession.id);
    return row?.outputSnapshot.includes('echo-json:hello-json') ? row : undefined;
  });
  await waitFor(() => (logs.seen.some((record) => record.event === 'external_agent.input') ? true : undefined));

  const unsupportedHistory = await call(
    'GET',
    `/v1/external-agent-sessions/${nativeSession.id}/history-page?transcriptTargetId=${sessionId}&limit=1`
  );
  expect(unsupportedHistory.status).toBe(200);
  expect(await unsupportedHistory.json()).toEqual({ events: [] });

  const stop = await call(
    'POST',
    `/v1/external-agent-sessions/${nativeSession.id}/stop?transcriptTargetId=${sessionId}`
  );
  expect(stop.status).toBe(200);
  events = handlers.store.listEvents(sessionId);
  expect(events.some((event) => event.type === 'external_agent.exited')).toBe(true);
  expect((await logs.done).some((record) => record.event === 'external_agent.stop')).toBe(true);
  await Bun.sleep(50);
  expect(handlers.store.getExternalAgentSession(nativeSession.id)?.state).toBe('stopped');
}

async function runProviderApprovalRuntime(
  call: Call,
  dir: string,
  projectDir: string,
  handlers: ReturnType<typeof buildHandlers>
): Promise<void> {
  await configureMockCodexApprovalAgent(call, dir);
  const sessionId = await createSession(call, projectDir);

  const res = await call('POST', `/v1/sessions/${sessionId}/external-agents/start`, {
    agentName: 'mock-codex-approval',
    workingPath: projectDir,
    launchMode: 'app-server'
  });
  expect(res.status).toBe(200);
  const nativeSession = ((await res.json()) as { session: ExternalAgentSessionView }).session;

  await waitFor(() => {
    const events = handlers.store.listEvents(sessionId);
    return events.some((event) => event.type === 'external_agent.approval_requested') &&
      handlers.store.getExternalAgentSession(nativeSession.id)?.providerSessionRef === 'codex-thread-1'
      ? events
      : undefined;
  });

  const input = await call(
    'POST',
    `/v1/external-agent-sessions/${nativeSession.id}/input?transcriptTargetId=${sessionId}`,
    { input: 'summarize' }
  );
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
  const requested = events.find((event) => event.type === 'external_agent.approval_requested');
  expect(requested?.payload.provider).toBe('codex');
  expect(requested?.payload.requestId).toBe('req_provider_1');
  expect(String(requested?.payload.text)).toContain('curl https://example.com');
  expect(events.some((event) => event.type === 'tool.approval_requested')).toBe(false);

  const approval = await call(
    'POST',
    `/v1/external-agent-sessions/${nativeSession.id}/approval?transcriptTargetId=${sessionId}`,
    {
      requestId: 'req_provider_1',
      allow: true,
      reason: 'approved in test'
    }
  );
  expect(approval.status).toBe(200);
  await waitFor(() => {
    const events = handlers.store.listEvents(sessionId);
    return events.some(
      (event) =>
        event.type === 'external_agent.approval_resolved' &&
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

  const stop = await call(
    'POST',
    `/v1/external-agent-sessions/${nativeSession.id}/stop?transcriptTargetId=${sessionId}`
  );
  expect(stop.status).toBe(200);
}

async function runManagedProviderApprovalSuppressedRuntime(
  call: Call,
  dir: string,
  projectDir: string,
  handlers: ReturnType<typeof buildHandlers>
): Promise<void> {
  await configureMockCodexApprovalAgent(call, dir);
  const sessionId = await createSession(call, projectDir);

  const res = await call('POST', `/v1/sessions/${sessionId}/external-agents/start`, {
    agentName: 'mock-codex-approval',
    workingPath: projectDir,
    launchMode: 'app-server',
    runtimeRole: 'managed-project-agent'
  });
  expect(res.status).toBe(200);
  const nativeSession = ((await res.json()) as { session: ExternalAgentSessionView }).session;

  await waitFor(async () => {
    const text = await Bun.file(join(dir, 'mock-codex-stdin.jsonl'))
      .text()
      .catch(() => '');
    if (!text.includes('"id":"req_provider_1"') || !text.includes('"decision":"decline"')) return undefined;
    return true;
  });

  const events = handlers.store.listEvents(sessionId);
  expect(events.some((event) => event.type === 'external_agent.approval_requested')).toBe(false);
  expect(events.some((event) => event.type === 'external_agent.approval_resolved')).toBe(false);
  expect(handlers.store.getExternalAgentSession(nativeSession.id)?.runtimeRole).toBe('managed-project-agent');

  const stop = await call(
    'POST',
    `/v1/external-agent-sessions/${nativeSession.id}/stop?transcriptTargetId=${sessionId}`
  );
  expect(stop.status).toBe(200);
}

async function runCodexResumeRuntime(call: Call, dir: string, projectDir: string): Promise<void> {
  await configureMockCodexApprovalAgent(call, dir);
  const sessionId = await createSession(call, projectDir);

  const res = await call('POST', `/v1/sessions/${sessionId}/external-agents/start`, {
    agentName: 'mock-codex-approval',
    workingPath: projectDir,
    launchMode: 'app-server',
    providerSessionRef: 'codex-thread-resume'
  });
  expect(res.status).toBe(200);
  const nativeSession = ((await res.json()) as { session: ExternalAgentSessionView }).session;
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
    experimentalApi: true,
    requestAttestation: false
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

  await call('POST', `/v1/external-agent-sessions/${nativeSession.id}/stop?transcriptTargetId=${sessionId}`);
}

async function runSlowCodexAppServerStartupRuntime(call: Call, dir: string, projectDir: string): Promise<void> {
  await configureMockSlowCodexAppServerAgent(call, dir);
  const sessionId = await createSession(call, projectDir);

  const res = await call('POST', `/v1/sessions/${sessionId}/external-agents/start`, {
    agentName: 'mock-codex-slow-app-server',
    workingPath: projectDir,
    launchMode: 'app-server'
  });
  expect(res.status).toBe(200);
  const nativeSession = ((await res.json()) as { session: ExternalAgentSessionView }).session;
  expect(nativeSession.launchMode).toBe('app-server');

  await call('POST', `/v1/external-agent-sessions/${nativeSession.id}/stop?transcriptTargetId=${sessionId}`);
}

async function runCodexOversizedStructuredLineRuntime(
  call: Call,
  dir: string,
  projectDir: string,
  handlers: ReturnType<typeof buildHandlers>
): Promise<void> {
  await configureMockCodexOversizedLineAgent(call, dir);
  const sessionId = await createSession(call, projectDir);

  const res = await call('POST', `/v1/sessions/${sessionId}/external-agents/start`, {
    agentName: 'mock-codex-oversized-line',
    workingPath: projectDir,
    launchMode: 'app-server'
  });
  expect(res.status).toBe(200);
  const nativeSession = ((await res.json()) as { session: ExternalAgentSessionView }).session;

  await waitFor(() => {
    const row = handlers.store.getExternalAgentSession(nativeSession.id);
    const events = handlers.store.listEvents(sessionId);
    return row?.providerSessionRef === 'codex-thread-light' &&
      events.some(
        (event) => event.type === 'external_agent.approval_requested' && event.payload.requestId === 'req_after_huge'
      )
      ? row
      : undefined;
  });
  const row = handlers.store.getExternalAgentSession(nativeSession.id);
  expect(row?.outputSnapshot.length).toBeLessThanOrEqual(256 * 1024);

  await call('POST', `/v1/external-agent-sessions/${nativeSession.id}/stop?transcriptTargetId=${sessionId}`);
}

async function runAuthRelayRuntime(
  call: Call,
  fetchPath: FetchPath,
  dir: string,
  handlers: ReturnType<typeof buildHandlers>
): Promise<void> {
  await configureMockAuthAgent(call, dir);

  let res = await call('POST', '/v1/external-agents/mock-native-auth/auth/start');
  expect(res.status).toBe(200);
  const authSession = ((await res.json()) as { session: ExternalAgentAuthSessionView }).session;
  expect(authSession.id.startsWith('ncliauth_')).toBe(true);
  expect(authSession.provider).toBe('claude-code');
  expect(authSession.authState).toBe('unknown');
  expect(await Bun.file(join(dir, 'external-agent-auth-processes.json')).exists()).toBe(true);

  expect(authSession.controlToken.length).toBeGreaterThanOrEqual(32);
  res = await call(
    'GET',
    `/v1/external-agent-auth-sessions/${authSession.id}?controlToken=wrong-token-wrong-token-wrong-token`
  );
  expect(res.status).toBe(404);

  let stream = streamExternalAgentAuth(fetchPath, authSession.id, authSession.controlToken, (session) =>
    session.outputSnapshot.includes('provider.example/login')
  );
  await stream.connected;
  expect((await stream.done).at(-1)?.outputSnapshot).toContain('provider.example/login');

  res = await call(
    'POST',
    `/v1/external-agent-auth-sessions/${authSession.id}/input?controlToken=${authSession.controlToken}`,
    {
      input: '1234\n'
    }
  );
  expect(res.status).toBe(200);
  stream = streamExternalAgentAuth(fetchPath, authSession.id, authSession.controlToken, (session) =>
    session.outputSnapshot.includes('auth-input:1234')
  );
  await stream.connected;
  expect((await stream.done).at(-1)?.outputSnapshot).toContain('auth-input:1234');

  res = await call(
    'POST',
    `/v1/external-agent-auth-sessions/${authSession.id}/resize?controlToken=${authSession.controlToken}`,
    {
      cols: 90,
      rows: 24
    }
  );
  expect(res.status).toBe(200);

  res = await call('GET', '/v1/external-agents/mock-native-auth/auth/status');
  expect(res.status).toBe(200);
  expect(((await res.json()) as { state: string }).state).toBe('authenticated');

  res = await call('GET', '/v1/external-agents/mock-native-auth/usage');
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    agentName: 'mock-native-auth',
    provider: 'claude-code',
    records: []
  });

  expect(handlers.store.listExternalAgentSessionsForTranscriptTarget('ses_UNKNOWN00000')).toHaveLength(0);

  res = await call(
    'POST',
    `/v1/external-agent-auth-sessions/${authSession.id}/stop?controlToken=${authSession.controlToken}`
  );
  expect(res.status).toBe(200);
  const stopped = await call(
    'GET',
    `/v1/external-agent-auth-sessions/${authSession.id}?controlToken=${authSession.controlToken}`
  );
  expect(((await stopped.json()) as { session: ExternalAgentAuthSessionView }).session.state).toBe('stopped');
  await waitFor(async () =>
    (await Bun.file(join(dir, 'external-agent-auth-processes.json')).exists()) ? undefined : true
  );
}

async function runAuthStartReplacesPreviousRuntime(call: Call, dir: string): Promise<void> {
  await configureMockAuthAgent(call, dir, { loginAuthenticates: false });

  let res = await call('POST', '/v1/external-agents/mock-native-auth/auth/start');
  expect(res.status).toBe(200);
  const first = ((await res.json()) as { session: ExternalAgentAuthSessionView }).session;

  res = await call('POST', '/v1/external-agents/mock-native-auth/auth/start');
  expect(res.status).toBe(200);
  const second = ((await res.json()) as { session: ExternalAgentAuthSessionView }).session;

  expect(second.id).not.toBe(first.id);
  res = await call('GET', `/v1/external-agent-auth-sessions/${first.id}?controlToken=${first.controlToken}`);
  expect(res.status).toBe(200);
  expect(((await res.json()) as { session: ExternalAgentAuthSessionView }).session.state).toBe('stopped');

  res = await call('GET', `/v1/external-agent-auth-sessions/${second.id}?controlToken=${second.controlToken}`);
  expect(res.status).toBe(200);
  expect(((await res.json()) as { session: ExternalAgentAuthSessionView }).session.state).toBe('running');
  await call('POST', `/v1/external-agent-auth-sessions/${second.id}/stop?controlToken=${second.controlToken}`);
}

async function runAuthHeartbeatRuntime(call: Call, dir: string): Promise<void> {
  await configureMockAuthAgent(call, dir, { loginAuthenticates: false });

  let res = await call('POST', '/v1/external-agents/mock-native-auth/auth/start');
  expect(res.status).toBe(200);
  const authSession = ((await res.json()) as { session: ExternalAgentAuthSessionView }).session;

  res = await call(
    'POST',
    `/v1/external-agent-auth-sessions/${authSession.id}/heartbeat?controlToken=${authSession.controlToken}`
  );
  expect(res.status).toBe(200);

  await Bun.sleep(100);
  res = await call(
    'GET',
    `/v1/external-agent-auth-sessions/${authSession.id}?controlToken=${authSession.controlToken}`
  );
  expect(res.status).toBe(200);
  expect(((await res.json()) as { session: ExternalAgentAuthSessionView }).session.state).toBe('running');

  await Bun.sleep(750);
  res = await call(
    'GET',
    `/v1/external-agent-auth-sessions/${authSession.id}?controlToken=${authSession.controlToken}`
  );
  expect(res.status).toBe(200);
  expect(((await res.json()) as { session: ExternalAgentAuthSessionView }).session.state).toBe('stopped');
}

async function runAuthStartSkipsLoginWhenAlreadyAuthenticatedRuntime(call: Call, dir: string): Promise<void> {
  await configureMockAuthAgent(call, dir, { initiallyAuthenticated: true });

  const res = await call('POST', '/v1/external-agents/mock-native-auth/auth/start');
  expect(res.status).toBe(200);
  const authSession = ((await res.json()) as { session: ExternalAgentAuthSessionView }).session;

  expect(authSession.id.startsWith('ncliauth_')).toBe(true);
  expect(authSession.provider).toBe('claude-code');
  expect(authSession.authState).toBe('authenticated');
  expect(authSession.state).toBe('exited');
  expect(authSession.exitCode).toBe(0);
  expect(authSession.pid).toBe(0);
  expect(await Bun.file(join(dir, 'mock-native-login-started')).exists()).toBe(false);
  expect(await Bun.file(join(dir, 'external-agent-auth-processes.json')).exists()).toBe(false);
}

async function runAuthStatusTimeoutRuntime(call: Call, dir: string): Promise<void> {
  await configureHangingAuthStatusAgent(call, dir);

  const res = await call('GET', '/v1/external-agents/mock-hanging-auth-status/auth/status');
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

  const res = await call('POST', `/v1/sessions/${sessionId}/external-agents/start`, {
    agentName: 'mock-codex-approval',
    workingPath: projectDir,
    launchMode: 'app-server'
  });
  expect(res.status).toBe(200);
  const nativeSession = ((await res.json()) as { session: ExternalAgentSessionView }).session;
  await waitFor(() => {
    const row = handlers.store.getExternalAgentSession(nativeSession.id);
    return row?.providerSessionRef === 'codex-thread-1' ? row : undefined;
  });

  const page = await call(
    'GET',
    `/v1/external-agent-sessions/${nativeSession.id}/history-page?transcriptTargetId=${sessionId}&limit=1&itemsView=summary&sortDirection=desc`
  );
  expect(page.status).toBe(200);
  const pageBody = (await page.json()) as {
    events: Array<{ role: string; text: string; source: string; providerEventType: string; raw: unknown }>;
    nextCursor: string;
  };
  expect(pageBody.nextCursor).toBe('provider:next_cursor');
  // Server-normalized cards: the daemon already knows this session's provider and normalizes with
  // the same adapter used for parseOutput/historyPageOutput — see storedOutputHistoryPage. No
  // separate raw-items array: each event's `raw` carries its source record.
  expect(
    pageBody.events.map(({ role, text, source, providerEventType, raw }) => ({
      role,
      text,
      source,
      providerEventType,
      raw
    }))
  ).toEqual([
    {
      role: 'system',
      text: 'turn/started',
      source: 'codex-app-server',
      providerEventType: 'turn/started',
      raw: { method: 'turn/started', params: { threadId: 'codex-thread-1', turnId: 'turn_1' } }
    },
    {
      role: 'system',
      text: 'turn/completed',
      source: 'codex-app-server',
      providerEventType: 'turn/completed',
      raw: { method: 'turn/completed', params: { threadId: 'codex-thread-1', turnId: 'turn_1' } }
    }
  ]);

  const secondPage = await call(
    'GET',
    `/v1/external-agent-sessions/${nativeSession.id}/history-page?transcriptTargetId=${sessionId}&limit=1&itemsView=summary&sortDirection=desc&before=${encodeURIComponent(pageBody.nextCursor)}`
  );
  expect(secondPage.status).toBe(200);
  expect(((await secondPage.json()) as { nextCursor?: string }).nextCursor).toBe('provider:next_cursor');

  const badCursorPage = await call(
    'GET',
    `/v1/external-agent-sessions/${nativeSession.id}/history-page?transcriptTargetId=${sessionId}&limit=1&itemsView=summary&sortDirection=desc&before=${encodeURIComponent('provider:bogus')}`
  );
  expect(badCursorPage.status).toBe(502);
  const badCursorBody = (await badCursorPage.json()) as { error: string; code: string };
  expect(badCursorBody.code).toBe('provider_protocol_error');
  expect(badCursorBody.error).toBe('invalid cursor: bogus');

  await call('POST', `/v1/external-agent-sessions/${nativeSession.id}/stop?transcriptTargetId=${sessionId}`);
}

async function runSpawnFailureRuntime(
  call: Call,
  projectDir: string,
  handlers: ReturnType<typeof buildHandlers>
): Promise<void> {
  await configureMissingBinaryAgent(call);
  const sessionId = await createSession(call, projectDir);

  const res = await call('POST', `/v1/sessions/${sessionId}/external-agents/start`, {
    agentName: 'missing-cli',
    workingPath: projectDir,
    launchMode: 'json-stream'
  });
  expect(res.status).toBeGreaterThanOrEqual(400);

  const failed = await waitFor(() => {
    const row = handlers.store
      .listExternalAgentSessionsForTranscriptTarget(sessionId)
      .find((candidate) => candidate.state === 'failed');
    return row?.outputSnapshot.includes('/definitely/not/a/external-agent-provider') ? row : undefined;
  });
  expect(failed.pid).toBeNull();
  expect(Date.parse(failed.exitedAt ?? '')).toBeGreaterThan(0);
  expect(handlers.store.listEvents(sessionId).some((event) => event.type === 'external_agent.exited')).toBe(true);
}

// Windows-skipped: these drive mock provider CLIs that are `#!/usr/bin/env bun` scripts (directly
// executable only via a Unix shebang), and several exercise PTY mode, which Bun's ConPTY support on
// Windows cannot capture/relay. The external-agent adapter itself spawns a real provider .exe on Windows
// and is covered by the unit adapter tests; only this mock-driven integration harness is Unix-shaped.
for (const kind of TRANSPORTS) {
  describe.skipIf(process.platform === 'win32')(`external-agent runtime over ${kind}`, () => {
    test('starts a provider-owned CLI session and relays IO', async () => {
      const { dir, projectDir, app, handlers } = await setup();
      const t = serveTransport(kind, app);
      try {
        await runRuntime((m, p, b) => t.fetch(p, jsonInit(m, b)), projectDir, handlers);
      } finally {
        await t.stop();
        for (const row of handlers.store.listExternalAgentSessionsForTranscriptTarget('ses_UNKNOWN00000')) {
          handlers.store.closeExternalAgentSession(row.id, new Date().toISOString(), null, 'stopped');
        }
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('routes turn interrupt and steer requests', async () => {
      const { dir, projectDir, app, handlers } = await setup();
      const t = serveTransport(kind, app);
      try {
        await runInterruptSteerRuntime((m, p, b) => t.fetch(p, jsonInit(m, b)), projectDir, handlers);
      } finally {
        await t.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('stops active external agent sessions when a project session is reset', async () => {
      const { dir, projectDir, app, handlers } = await setup();
      const t = serveTransport(kind, app);
      try {
        await runSessionResetStopsExternalAgentRuntime((m, p, b) => t.fetch(p, jsonInit(m, b)), projectDir, handlers);
      } finally {
        await t.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test(
      'stops active external agent sessions when a project session is deleted',
      async () => {
        const { dir, projectDir, app, handlers } = await setup();
        const t = serveTransport(kind, app);
        try {
          await runSessionDeleteStopsExternalAgentRuntime(
            (m, p, b) => t.fetch(p, jsonInit(m, b)),
            projectDir,
            handlers
          );
        } finally {
          await t.stop();
          await rm(dir, { recursive: true, force: true });
        }
      },
      SESSION_DELETE_TEST_TIMEOUT_MS
    );

    test('normalizes external agent working paths through realpath', async () => {
      const { dir, projectDir, app } = await setup();
      const t = serveTransport(kind, app);
      try {
        await runWorkingPathRealpathRuntime((m, p, b) => t.fetch(p, jsonInit(m, b)), dir, projectDir);
      } finally {
        await t.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('rejects direct external agent starts outside the project working path', async () => {
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

    test('suppresses provider-owned approvals for managed external agent runtimes', async () => {
      const { dir, projectDir, app, handlers } = await setup();
      const t = serveTransport(kind, app);
      try {
        await runManagedProviderApprovalSuppressedRuntime(
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

    test('allows slow Codex app-server thread startup during managed runtime cold starts', async () => {
      const { dir, projectDir, app } = await setup();
      const t = serveTransport(kind, app);
      try {
        await runSlowCodexAppServerStartupRuntime((m, p, b) => t.fetch(p, jsonInit(m, b)), dir, projectDir);
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

    test('relays provider-owned external agent auth flows without project session storage', async () => {
      const { dir, app, handlers } = await setup();
      const t = serveTransport(kind, app);
      try {
        await runAuthRelayRuntime((m, p, b) => t.fetch(p, jsonInit(m, b)), t.fetch, dir, handlers);
      } finally {
        await t.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('skips provider login when external agent auth status is already authenticated', async () => {
      const { dir, app } = await setup();
      const t = serveTransport(kind, app);
      try {
        await runAuthStartSkipsLoginWhenAlreadyAuthenticatedRuntime((m, p, b) => t.fetch(p, jsonInit(m, b)), dir);
      } finally {
        await t.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('starting an external agent auth connect flow stops the previous connect flow for that agent', async () => {
      const { dir, app } = await setup();
      const t = serveTransport(kind, app);
      try {
        await runAuthStartReplacesPreviousRuntime((m, p, b) => t.fetch(p, jsonInit(m, b)), dir);
      } finally {
        await t.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('external agent auth connect flows stop when their browser heartbeat expires', async () => {
      const { dir, app } = await setup({ externalAgentAuthHeartbeatTimeoutMs: 500 });
      const t = serveTransport(kind, app);
      try {
        await runAuthHeartbeatRuntime((m, p, b) => t.fetch(p, jsonInit(m, b)), dir);
      } finally {
        await t.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('returns a provider timeout code when external agent auth status hangs', async () => {
      const { dir, app } = await setup({ externalAgentAuthStatusTimeoutMs: 100 });
      const t = serveTransport(kind, app);
      try {
        await runAuthStatusTimeoutRuntime((m, p, b) => t.fetch(p, jsonInit(m, b)), dir);
      } finally {
        await t.stop();
        await rm(dir, { recursive: true, force: true });
      }
    }, 2_000);

    test('records failed external agent spawns in the lifecycle ledger', async () => {
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
