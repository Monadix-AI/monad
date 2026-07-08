// e2e: the channel-settings REST surface over a real temp ~/.monad, exercised over BOTH
// transports (TCP loopback and the Unix socket) per the repo rule. Asserts CRUD works and
// that the bot token is persisted to auth.json but NEVER returned by list()/status().

import type { MonadPaths } from '@monad/home';

import { describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initMonadHome, loadAuth, loadConfig } from '@monad/home';

import { ModelService } from '#/handlers/settings/model/index.ts';
import { createHttpTransport } from '#/transports/http.ts';
import {
  buildHandlers,
  makeTestPaths,
  mockModel,
  seededProviderRegistry,
  serveTransport,
  TRANSPORTS
} from '../helpers.ts';

function makePaths(base: string): MonadPaths {
  return makeTestPaths(base);
}

const CHANNEL_ID = 'chn_TESTCHANNEL';
const SECRET = 'super-secret-bot-token';

function channelView() {
  return {
    id: CHANNEL_ID,
    type: 'telegram',
    label: 'My Bot',
    enabled: true,
    options: {},
    allowlist: { allowAllUsers: false, allowedUsers: ['u1'] },
    mapping: { granularity: 'per-conversation' },
    rateLimitPerMin: 20
  };
}

type Call = (method: string, path: string, body?: unknown) => Promise<Response>;

interface ChannelsBody {
  channels: { id: string; enabled: boolean }[];
}
interface StatusBody {
  statuses: { id: string; hasToken: boolean }[];
}

// The full CRUD assertion sequence, transport-agnostic.
async function runChannelCrud(call: Call, paths: MonadPaths): Promise<void> {
  // 1. empty to start
  let res = await call('GET', '/v1/settings/channels');
  expect(res.status).toBe(200);
  expect(((await res.json()) as ChannelsBody).channels).toEqual([]);

  // 2. upsert a channel
  res = await call('PUT', `/v1/settings/channels/${CHANNEL_ID}`, { channel: channelView() });
  expect(res.status).toBe(200);

  // 3. it lists back without any token/tokenRef field
  res = await call('GET', '/v1/settings/channels');
  const { channels } = (await res.json()) as ChannelsBody;
  expect(channels.length).toBe(1);
  expect(channels[0]?.id).toBe(CHANNEL_ID);
  expect(JSON.stringify(channels[0])).not.toContain('token'); // no tokenRef / token leaked

  // 3b. get by id returns the same channel; unknown id 404s
  res = await call('GET', `/v1/settings/channels/${CHANNEL_ID}`);
  expect(res.status).toBe(200);
  const single = (await res.json()) as { channel: { id: string } };
  expect(single.channel.id).toBe(CHANNEL_ID);

  res = await call('GET', '/v1/settings/channels/chn_DOESNOTEXIST');
  expect(res.status).toBe(404);

  // 4. set the credential → persisted to auth.json, not echoed
  res = await call('PUT', `/v1/settings/channels/${CHANNEL_ID}/credential`, { token: SECRET });
  expect(res.status).toBe(200);
  const auth = await loadAuth(paths.auth);
  expect(auth?.channelCredentials?.[CHANNEL_ID]?.token).toBe(SECRET);

  // 5. status reports hasToken but never the token itself
  res = await call('GET', '/v1/settings/channels/status');
  const { statuses } = (await res.json()) as StatusBody;
  expect(statuses[0]?.id).toBe(CHANNEL_ID);
  expect(statuses[0]?.hasToken).toBe(true);
  expect(JSON.stringify(statuses)).not.toContain(SECRET);

  // 6. disable → reflected in list
  res = await call('POST', `/v1/settings/channels/${CHANNEL_ID}/disable`);
  expect(res.status).toBe(200);
  res = await call('GET', '/v1/settings/channels');
  expect(((await res.json()) as ChannelsBody).channels[0]?.enabled).toBe(false);

  // 7. remove → gone, and its credential is cleared from auth.json
  res = await call('DELETE', `/v1/settings/channels/${CHANNEL_ID}`);
  expect(res.status).toBe(200);
  res = await call('GET', '/v1/settings/channels');
  expect(((await res.json()) as ChannelsBody).channels).toEqual([]);
  const authAfter = await loadAuth(paths.auth);
  expect(authAfter?.channelCredentials?.[CHANNEL_ID]).toBeUndefined();
}

async function setup(): Promise<{ dir: string; paths: MonadPaths; app: ReturnType<typeof createHttpTransport> }> {
  const dir = join(tmpdir(), `monad-chsettings-${process.pid}-${Date.now()}-${process.hrtime.bigint()}`);
  const paths = makePaths(dir);
  await initMonadHome(paths);
  const cfg = await loadConfig(paths.config);
  if (!cfg) throw new Error('config missing after init');
  const modelService = new ModelService(paths.auth, cfg, await loadAuth(paths.auth), seededProviderRegistry());
  const app = createHttpTransport(buildHandlers(mockModel(), { paths, modelService }));
  return { dir, paths, app };
}

const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body)
});

for (const kind of TRANSPORTS) {
  describe(`channel-settings over ${kind}`, () => {
    test('channel-settings CRUD', async () => {
      const { dir, paths, app } = await setup();
      const t = serveTransport(kind, app);
      try {
        await runChannelCrud((m, p, b) => t.fetch(p, jsonInit(m, b)), paths);
      } finally {
        await t.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
}
