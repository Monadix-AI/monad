import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultConfig, saveAll } from '@monad/home';

import { createHttpTransport } from '@/transports/http.ts';
import { buildHandlers, makeTestPaths, mockModel, stubModelDeps } from '../../helpers.ts';

// Unit-level: drive the Elysia app via app.handle() — no network socket.
function buildApp(opts?: Parameters<typeof buildHandlers>[2]) {
  return createHttpTransport(buildHandlers(mockModel(['hello']), undefined, opts));
}

test('GET /health returns ok without a network socket', async () => {
  const app = buildApp();
  const res = await app.handle(new Request('http://localhost/health'));
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ status: 'ok' });
});

test('POST /v1/sessions creates a session and returns a ses_ id', async () => {
  const app = buildApp();
  const res = await app.handle(
    new Request('http://localhost/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'unit test' })
    })
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { sessionId: string };
  expect(body.sessionId).toMatch(/^ses_/);
});

test('POST /v1/tools/approve resolves an approval (ok:false for an unknown request id)', async () => {
  const app = buildApp();
  const res = await app.handle(
    new Request('http://localhost/v1/tools/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'gate_UNKNOWN', allow: true })
    })
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: false });
});

test('GET /v1/skills returns the discovered-skills listing', async () => {
  const app = buildApp();
  const res = await app.handle(new Request('http://localhost/v1/skills'));
  expect(res.status).toBe(200);
  // buildHandlers seeds no skills, so the list is empty — but the route is wired + typed.
  expect(await res.json()).toEqual({ skills: [], skillInstances: [] });
});

test('GET /v1/skills?scope=global,atom-pack filters by-agent skill instances server-side', async () => {
  const skillInstances = [
    {
      id: 'global:summarize-changes',
      sourceKind: 'global' as const,
      sourceId: 'global',
      source: 'global',
      active: true,
      name: 'summarize-changes',
      description: 'Global skill.',
      userInvocable: true,
      available: true
    },
    {
      id: 'agent:default:summarize-changes',
      sourceKind: 'agent' as const,
      sourceId: 'agent:default',
      source: 'agent:default',
      active: true,
      name: 'summarize-changes',
      description: 'Agent skill.',
      userInvocable: true,
      available: true
    },
    {
      id: 'atom-pack:monad-test:summarize-changes',
      sourceKind: 'atom-pack' as const,
      sourceId: 'atom-pack:monad-test',
      source: 'atom-pack:monad-test',
      active: false,
      name: 'summarize-changes',
      description: 'Pack skill.',
      userInvocable: true,
      available: true
    }
  ];
  const app = buildApp({ skillInstances });

  const runtime = await app.handle(new Request('http://localhost/v1/skills'));
  expect(((await runtime.json()) as { skillInstances: Array<{ id: string }> }).skillInstances.map((s) => s.id)).toEqual(
    ['global:summarize-changes', 'agent:default:summarize-changes', 'atom-pack:monad-test:summarize-changes']
  );

  const global = await app.handle(new Request('http://localhost/v1/skills?scope=global,atom-pack'));
  expect(global.status).toBe(200);
  expect(((await global.json()) as { skillInstances: Array<{ id: string }> }).skillInstances.map((s) => s.id)).toEqual([
    'global:summarize-changes',
    'atom-pack:monad-test:summarize-changes'
  ]);

  const onlyGlobal = await app.handle(new Request('http://localhost/v1/skills?scope=global'));
  expect(onlyGlobal.status).toBe(200);
  expect(
    ((await onlyGlobal.json()) as { skillInstances: Array<{ id: string }> }).skillInstances.map((s) => s.id)
  ).toEqual(['global:summarize-changes']);
});

test('framework agent settings routes persist the typed config contract', async () => {
  const root = await mkdtemp(join(tmpdir(), 'monad-framework-agent-routes-'));
  const paths = makeTestPaths(root);
  await saveAll(paths.config, paths.profile, createDefaultConfig('prn_test', 'Test'));
  const app = createHttpTransport(buildHandlers(mockModel(['hello']), { ...stubModelDeps(), paths }));
  const agent = {
    name: 'openclaw-local',
    provider: 'openclaw',
    transport: 'cli-oneshot',
    command: 'openclaw',
    args: ['run'],
    enabled: true,
    osSandbox: false,
    forwardMcp: false
  };

  try {
    const put = await app.handle(
      new Request('http://localhost/v1/settings/framework-agents', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent })
      })
    );
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ ok: true });

    const listed = await app.handle(new Request('http://localhost/v1/settings/framework-agents'));
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ agents: [agent] });

    const disabled = await app.handle(
      new Request(`http://localhost/v1/settings/framework-agents/${agent.name}/disable`, { method: 'POST' })
    );
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toEqual({ ok: true });

    const afterDisable = (await (
      await app.handle(new Request('http://localhost/v1/settings/framework-agents'))
    ).json()) as { agents: Array<typeof agent> };
    expect(afterDisable.agents).toEqual([{ ...agent, enabled: false }]);

    const removed = await app.handle(
      new Request(`http://localhost/v1/settings/framework-agents/${agent.name}`, { method: 'DELETE' })
    );
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true });

    const afterRemove = await app.handle(new Request('http://localhost/v1/settings/framework-agents'));
    expect(await afterRemove.json()).toEqual({ agents: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createSession(app: ReturnType<typeof buildApp>, title: string): Promise<string> {
  const res = await app.handle(
    new Request('http://localhost/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title })
    })
  );
  return ((await res.json()) as { sessionId: string }).sessionId;
}

test('POST /v1/sessions/:id/messages accepts a streaming turn', async () => {
  const app = buildApp();
  const sessionId = await createSession(app, 'msg test');
  const res = await app.handle(
    new Request(`http://localhost/v1/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' })
    })
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ accepted: true });
});

test('POST /v1/sessions/:id/messages with generate:false records only the user message', async () => {
  const app = buildApp();
  const sessionId = await createSession(app, 'timeline only');
  const res = await app.handle(
    new Request(`http://localhost/v1/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'record this', generate: false })
    })
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ accepted: true });

  await Bun.sleep(50);
  const listed = await app.handle(new Request(`http://localhost/v1/sessions/${sessionId}/messages`));
  expect(listed.status).toBe(200);
  const body = (await listed.json()) as { messages: Array<{ role: string; text: string }> };
  expect(body.messages.map((message) => [message.role, message.text])).toEqual([['user', 'record this']]);
});

test('POST /v1/sessions/:id/messages/block returns the full assistant message', async () => {
  const app = createHttpTransport(buildHandlers(mockModel(['Hello', ' world'])));
  const sessionId = await createSession(app, 'block test');
  const res = await app.handle(
    new Request(`http://localhost/v1/sessions/${sessionId}/messages/block`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' })
    })
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { message: { role: string; text: string } };
  expect(body.message.role).toBe('assistant');
  expect(body.message.text).toBe('Hello world');
});
