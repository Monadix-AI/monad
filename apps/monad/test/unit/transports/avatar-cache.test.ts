import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { avatarCacheKey } from '@monad/protocol';

import { createAvatarCacheController } from '@/transports/http/avatar-cache.ts';

const realFetch = globalThis.fetch;
const realHome = Bun.env.MONAD_HOME;

let home: string;

beforeEach(() => {
  home = join(tmpdir(), `monad-avatar-cache-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  Bun.env.MONAD_HOME = home;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  Bun.env.MONAD_HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

test('avatar cache only writes on explicit save warmup', async () => {
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    return new Response('<svg>avatar</svg>', { headers: { 'content-type': 'image/svg+xml' } });
  }) as unknown as typeof fetch;

  const app = createAvatarCacheController({} as never);
  const seed = 'user:Operator';
  const key = avatarCacheKey(seed);
  const cachePath = join(home, 'cache', 'avatars', `${key}.svg`);
  const readUrl = `http://localhost/api/avatar-cache/${key}.svg?seed=${encodeURIComponent(seed)}`;

  const preview = await app.handle(new Request(readUrl));
  expect(preview.status).toBe(200);
  expect(preview.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  expect(await preview.text()).toBe('<svg>avatar</svg>');
  expect(existsSync(cachePath)).toBe(false);

  const warm = await app.handle(new Request(`${readUrl}&write=1`));
  expect(warm.status).toBe(200);
  expect(await readFile(cachePath, 'utf8')).toBe('<svg>avatar</svg>');

  const cached = await app.handle(new Request(readUrl));
  expect(cached.status).toBe(200);
  expect(cached.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  expect(fetches).toBe(2);
});
