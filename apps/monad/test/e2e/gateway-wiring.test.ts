// e2e: prove the full wiring — config.json + auth.json → ModelService gateway
// router → daemon HTTP — produces a completion against a real (stub) provider.
// The stub speaks the OpenAI chat-completions shape that openai-compatible uses.

import type { MonadConfig, MonadPaths } from '@monad/home';

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initMonadHome, loadAuth, loadConfig, saveAll, saveAuth } from '@monad/home';
import { enMessages as i18nMessages } from '@monad/i18n/messages';
import { ModelProviderType, newId } from '@monad/protocol';

import { createAgent } from '#/agent/index.ts';
import { ChannelService } from '#/channels/channel.ts';
import { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';
import { ModelService } from '#/handlers/settings/model/index.ts';
import { EventBus } from '#/services/event-bus.ts';
import { ClarifyService } from '#/services/generation/clarify.ts';
import { I18nService } from '#/services/i18n.ts';
import { GraphStore } from '#/services/memory/graph/store.ts';
import { OversightService } from '#/services/oversight.ts';
import { RoundCache } from '#/services/round-cache.ts';
import { createStore } from '#/store/db/index.ts';
import { createHttpTransport } from '#/transports/http.ts';
import { makeTestPaths, seededProviderRegistry, stubMemoryService } from '../helpers.ts';

function makePaths(b: string): MonadPaths {
  return makeTestPaths(b);
}

let dir: string;
let paths: MonadPaths;
let stub: ReturnType<typeof Bun.serve>;
let daemon: { port: number; stop: (f?: boolean) => void };
let base: string;

beforeEach(async () => {
  // 1. A stub OpenAI-compatible provider.
  stub = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/chat/completions')) {
        return Response.json({
          choices: [{ message: { role: 'assistant', content: 'pong from stub' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
        });
      }
      return new Response('not found', { status: 404 });
    }
  });
  const stubUrl = `http://127.0.0.1:${stub.port}`;

  // 2. A home configured with that provider + a default profile + a credential.
  dir = join(tmpdir(), `monad-gw-${Date.now()}-${process.hrtime.bigint()}`);
  paths = makePaths(dir);
  await initMonadHome(paths);

  const cfg = (await loadConfig(paths.config)) as MonadConfig;
  cfg.model.providers = [
    {
      id: 'stub',
      label: 'Stub',
      type: ModelProviderType.OpenAICompatible,
      baseUrl: `${stubUrl}/v1`
    }
  ];
  cfg.model.profiles = [
    { alias: 'default', routes: { chat: { provider: 'stub', modelId: 'stub-model' } }, params: {}, fallbacks: [] }
  ];
  cfg.model.default = 'default';
  await saveAll(paths.config, paths.profile, cfg);

  await saveAuth(paths.auth, {
    version: 1,
    activeProvider: 'stub',
    updatedAt: new Date().toISOString(),
    credentialPool: {
      stub: [
        {
          id: newId('cred'),
          label: 'k',
          authType: 'api_key',
          priority: 0,
          source: 'manual',
          accessToken: 'sk-test',
          lastStatus: 'unknown',
          lastStatusAt: null,
          lastErrorCode: null,
          lastErrorReason: null,
          lastErrorMessage: null,
          lastErrorResetAt: null,
          requestCount: 0
        }
      ]
    }
  });

  // 3. The real daemon wiring (gateway router, not the mock).
  const modelService = new ModelService(paths.auth, cfg, await loadAuth(paths.auth), seededProviderRegistry());
  const store = createStore();
  const agent = createAgent({
    model: modelService.router,
    sessionRepo: { insertSession: (s) => store.insertSession(s), getSession: (id) => store.getSession(id) },
    messageRepo: {
      list: (sid) => store.listMessages(sid),
      append: (m) => store.insertMessage(m.id, m.sessionId, m.text, m.createdAt, m.role)
    },
    defaultModel: cfg.model.default
  });
  const i18n = new I18nService([{ locale: 'en', name: 'English', messages: i18nMessages }], 'en');
  const channelService = new ChannelService(
    {
      session: { createForPrincipal: async () => ({ sessionId: newId('ses') }), sendInline: async () => {} },
      store,
      registry: new Map(),
      bus: new EventBus(),
      t: i18n.t,
      log: { info: () => {}, warn: () => {}, error: () => {} }
    },
    cfg,
    (await loadAuth(paths.auth)) ?? { version: 1, activeProvider: null, updatedAt: '', credentialPool: {} }
  );
  const handlers = createDaemonHandlers({
    store,
    agent,
    bus: new EventBus(),
    cache: new RoundCache(),
    ownerPrincipalId: newId('prn'),
    paths,
    modelService,
    oversight: new OversightService({ publish: () => {} }),
    clarify: new ClarifyService({ publish: () => {} }),
    channelService,
    localeService: i18n,
    memoryService: stubMemoryService(store),
    graphStore: new GraphStore(':memory:'),
    getMem0Data: async () => ({
      available: false,
      vectorStore: 'memory',
      qdrant: null,
      total: 0,
      scopeCounts: [],
      entries: []
    }),
    getLaws: async () => ({ laws: [] }),
    memorySetBackend: async () => {},
    memorySetMem0Models: async () => {},
    memorySetGraph: async () => {},
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    skills: []
  });
  const app = createHttpTransport(handlers).listen({ hostname: '127.0.0.1', port: 0 }) as unknown as {
    server: typeof daemon;
  };
  daemon = app.server;
  base = `http://127.0.0.1:${daemon.port}`;
});

afterEach(async () => {
  daemon.stop(true);
  stub.stop(true);
  await rm(dir, { recursive: true, force: true });
});

test('a block turn routes through the gateway to the configured provider', async () => {
  const created = (await (
    await fetch(`${base}/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 't' })
    })
  ).json()) as { sessionId: string };

  const res = (await (
    await fetch(`${base}/v1/sessions/${created.sessionId}/messages/block`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'ping' })
    })
  ).json()) as { message: { role: string; text: string } };

  expect(res.message.role).toBe('assistant');
  expect(res.message.text).toBe('pong from stub');

  // The credential's health/usage was recorded back to auth.json (debounced write at 1000ms).
  // Use 2500ms on Windows where NTFS file writes are slower and the timing is less precise.
  await Bun.sleep(process.platform === 'win32' ? 2500 : 1100);
  const auth = await loadAuth(paths.auth);
  expect(auth?.credentialPool.stub?.[0]?.lastStatus).toBe('ok');
  expect(auth?.credentialPool.stub?.[0]?.requestCount).toBeGreaterThan(0);
});
