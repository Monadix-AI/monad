import type { AvatarStyle } from '@monad/protocol';
import type { createDaemonHandlers } from '@/handlers/handlers.ts';

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Avatar, Style } from '@dicebear/core';
import adventurer from '@dicebear/styles/adventurer.json' with { type: 'json' };
import avataaars from '@dicebear/styles/avataaars.json' with { type: 'json' };
import bigSmile from '@dicebear/styles/big-smile.json' with { type: 'json' };
import bottts from '@dicebear/styles/bottts.json' with { type: 'json' };
import loreleiStyle from '@dicebear/styles/lorelei.json' with { type: 'json' };
import micah from '@dicebear/styles/micah.json' with { type: 'json' };
import notionists from '@dicebear/styles/notionists.json' with { type: 'json' };
import openPeeps from '@dicebear/styles/open-peeps.json' with { type: 'json' };
import personas from '@dicebear/styles/personas.json' with { type: 'json' };
import thumbs from '@dicebear/styles/thumbs.json' with { type: 'json' };
import { getPaths } from '@monad/home';
import { avatarCacheKey, DEFAULT_AVATAR_STYLE, isAvatarStyle } from '@monad/protocol';
import { Elysia } from 'elysia';

// Styles are statically imported (rather than resolved from the `style` query param via a dynamic
// import) both because @dicebear/styles only publishes this fixed set and to keep the render path
// free of any attacker-controlled module specifier.
const STYLE_DEFINITIONS: Record<AvatarStyle, unknown> = {
  adventurer,
  avataaars,
  'big-smile': bigSmile,
  bottts,
  lorelei: loreleiStyle,
  micah,
  notionists,
  'open-peeps': openPeeps,
  personas,
  thumbs
};

const STYLES = new Map<AvatarStyle, Style<unknown>>(
  (Object.entries(STYLE_DEFINITIONS) as [AvatarStyle, unknown][]).map(([slug, definition]) => [
    slug,
    new Style<unknown>(definition)
  ])
);

function renderAvatarSvg(seed: string, style: AvatarStyle): string {
  const definition = STYLES.get(style);
  if (!definition) throw new Error(`avatar-cache: unknown style "${style}"`);
  return new Avatar(definition, { seed }).toString();
}

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
    const styleParam = url.searchParams.get('style') ?? '';
    const style: AvatarStyle = isAvatarStyle(styleParam) ? styleParam : DEFAULT_AVATAR_STYLE;
    const shouldWrite = url.searchParams.get('write') === '1';
    if (!seed || avatarCacheKey(seed, style) !== key) return new Response('Bad Request', { status: 400 });

    const cacheDir = join(getPaths().cache, 'avatars');
    const cachePath = join(cacheDir, `${key}.svg`);
    const cached = await readFile(cachePath, 'utf8').catch(() => null);
    if (cached) return svgResponse(cached);

    const svg = renderAvatarSvg(seed, style);
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
