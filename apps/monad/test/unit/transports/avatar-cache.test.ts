import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { avatarCacheKey } from '@monad/protocol';

import { createAvatarCacheController } from '@/transports/http/avatar-cache.ts';

const realHome = Bun.env.MONAD_HOME;

let home: string;

beforeEach(() => {
  home = join(tmpdir(), `monad-avatar-cache-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  Bun.env.MONAD_HOME = home;
});

afterEach(() => {
  Bun.env.MONAD_HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

test('GET never writes to the on-disk cache', async () => {
  const app = createAvatarCacheController({} as never);
  const seed = 'user:Operator';
  const key = avatarCacheKey(seed);
  const cachePath = join(home, 'cache', 'avatars', `${key}.svg`);
  const readUrl = `http://localhost/api/avatar-cache/${key}.svg?seed=${encodeURIComponent(seed)}`;

  const preview = await app.handle(new Request(readUrl));
  expect(preview.status).toBe(200);
  expect(preview.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  const svg = await preview.text();
  expect(svg).toContain('<svg');
  expect(existsSync(cachePath)).toBe(false);

  const again = await app.handle(new Request(readUrl));
  expect(again.status).toBe(200);
  expect(await again.text()).toBe(svg);
  expect(existsSync(cachePath)).toBe(false);
});

test('POST warms the on-disk cache, then GET serves the cached copy', async () => {
  const app = createAvatarCacheController({} as never);
  const seed = 'user:Operator';
  const key = avatarCacheKey(seed);
  const cachePath = join(home, 'cache', 'avatars', `${key}.svg`);
  const readUrl = `http://localhost/api/avatar-cache/${key}.svg?seed=${encodeURIComponent(seed)}`;

  const warm = await app.handle(new Request(readUrl, { method: 'POST' }));
  expect(warm.status).toBe(200);
  expect(warm.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  const svg = await warm.text();
  expect(await readFile(cachePath, 'utf8')).toBe(svg);

  const cached = await app.handle(new Request(readUrl));
  expect(cached.status).toBe(200);
  expect(cached.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  expect(await cached.text()).toBe(svg);
});

test('POST rejects a key that does not match the seed/style hash', async () => {
  const app = createAvatarCacheController({} as never);
  const res = await app.handle(
    new Request('http://localhost/api/avatar-cache/bogus.svg?seed=user:Operator', { method: 'POST' })
  );
  expect(res.status).toBe(400);
});

test('avatar rendering is deterministic per seed and style', async () => {
  const app = createAvatarCacheController({} as never);
  const seed = 'user:Renamed';
  const style = 'avataaars';
  const key = avatarCacheKey(seed, style);
  const url = `http://localhost/api/avatar-cache/${key}.svg?seed=${encodeURIComponent(seed)}&style=${style}`;

  const first = await app.handle(new Request(url));
  const second = await app.handle(new Request(url));
  expect(first.status).toBe(200);
  expect(await first.text()).toBe(await second.text());

  const defaultKey = avatarCacheKey(seed);
  expect(defaultKey).not.toBe(key);
});

test('rejects a key that does not match the seed/style hash', async () => {
  const app = createAvatarCacheController({} as never);
  const res = await app.handle(new Request('http://localhost/api/avatar-cache/bogus.svg?seed=user:Operator'));
  expect(res.status).toBe(400);
});

test('falls back to the default style for an unknown style param', async () => {
  const app = createAvatarCacheController({} as never);
  const seed = 'user:Operator';
  const key = avatarCacheKey(seed);
  const url = `http://localhost/api/avatar-cache/${key}.svg?seed=${encodeURIComponent(seed)}&style=not-a-real-style`;

  const res = await app.handle(new Request(url));
  expect(res.status).toBe(200);
});
