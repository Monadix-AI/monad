import type { createDaemonHandlers } from '@/handlers/handlers.ts';

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getPaths } from '@monad/home';
import { avatarCacheKey } from '@monad/protocol';
import { Elysia } from 'elysia';

const DICEBEAR_URL = 'https://api.dicebear.com/10.x/notionists/svg';

function svgResponse(body: string): Response {
  return new Response(body, {
    headers: {
      'cache-control': 'public, max-age=31536000, immutable',
      'content-type': 'image/svg+xml; charset=utf-8'
    }
  });
}

export function createAvatarCacheController(_handlers: ReturnType<typeof createDaemonHandlers>) {
  const handle = async ({ params, request }: { params: { hash: string }; request: Request }) => {
    const key = params.hash.replace(/\.svg$/, '');
    const url = new URL(request.url);
    const seed = url.searchParams.get('seed') ?? '';
    const shouldWrite = url.searchParams.get('write') === '1';
    if (!seed || avatarCacheKey(seed) !== key) return new Response('Bad Request', { status: 400 });

    const cacheDir = join(getPaths().cache, 'avatars');
    const cachePath = join(cacheDir, `${key}.svg`);
    const cached = await readFile(cachePath, 'utf8').catch(() => null);
    if (cached) return svgResponse(cached);

    const upstream = await fetch(`${DICEBEAR_URL}?seed=${encodeURIComponent(seed)}`, {
      headers: { accept: 'image/svg+xml' },
      signal: AbortSignal.timeout(10_000)
    }).catch(() => null);
    if (!upstream?.ok) return new Response('Bad Gateway', { status: 502 });

    const svg = await upstream.text();
    if (!shouldWrite) return svgResponse(svg);

    await mkdir(cacheDir, { recursive: true });
    const tmp = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, svg, 'utf8');
    await rename(tmp, cachePath).catch(async () => {
      await unlink(tmp).catch(() => {});
    });
    return svgResponse(svg);
  };
  return new Elysia({ tags: ['http-only'] }).get('/avatar-cache/:hash', handle).get('/api/avatar-cache/:hash', handle);
}
