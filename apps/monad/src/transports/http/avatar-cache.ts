import type { AvatarStyle } from '@monad/protocol';
import type { createDaemonHandlers } from '@/handlers/handlers.ts';

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Avatar, Style } from '@dicebear/core';
import adventurer from '@dicebear/styles/adventurer.json' with { type: 'json' };
import adventurerNeutral from '@dicebear/styles/adventurer-neutral.json' with { type: 'json' };
import avataaars from '@dicebear/styles/avataaars.json' with { type: 'json' };
import avataaarsNeutral from '@dicebear/styles/avataaars-neutral.json' with { type: 'json' };
import bigEars from '@dicebear/styles/big-ears.json' with { type: 'json' };
import bigEarsNeutral from '@dicebear/styles/big-ears-neutral.json' with { type: 'json' };
import bigSmile from '@dicebear/styles/big-smile.json' with { type: 'json' };
import bottts from '@dicebear/styles/bottts.json' with { type: 'json' };
import botttsNeutral from '@dicebear/styles/bottts-neutral.json' with { type: 'json' };
import croodles from '@dicebear/styles/croodles.json' with { type: 'json' };
import croodlesNeutral from '@dicebear/styles/croodles-neutral.json' with { type: 'json' };
import disco from '@dicebear/styles/disco.json' with { type: 'json' };
import dylan from '@dicebear/styles/dylan.json' with { type: 'json' };
import funEmoji from '@dicebear/styles/fun-emoji.json' with { type: 'json' };
import glass from '@dicebear/styles/glass.json' with { type: 'json' };
import glyphs from '@dicebear/styles/glyphs.json' with { type: 'json' };
import icons from '@dicebear/styles/icons.json' with { type: 'json' };
import identicon from '@dicebear/styles/identicon.json' with { type: 'json' };
import initialFace from '@dicebear/styles/initial-face.json' with { type: 'json' };
import initials from '@dicebear/styles/initials.json' with { type: 'json' };
import loreleiStyle from '@dicebear/styles/lorelei.json' with { type: 'json' };
import loreleiNeutral from '@dicebear/styles/lorelei-neutral.json' with { type: 'json' };
import micah from '@dicebear/styles/micah.json' with { type: 'json' };
import miniavs from '@dicebear/styles/miniavs.json' with { type: 'json' };
import notionists from '@dicebear/styles/notionists.json' with { type: 'json' };
import notionistsNeutral from '@dicebear/styles/notionists-neutral.json' with { type: 'json' };
import openPeeps from '@dicebear/styles/open-peeps.json' with { type: 'json' };
import personas from '@dicebear/styles/personas.json' with { type: 'json' };
import pixelArt from '@dicebear/styles/pixel-art.json' with { type: 'json' };
import pixelArtNeutral from '@dicebear/styles/pixel-art-neutral.json' with { type: 'json' };
import rings from '@dicebear/styles/rings.json' with { type: 'json' };
import shapeGrid from '@dicebear/styles/shape-grid.json' with { type: 'json' };
import shapes from '@dicebear/styles/shapes.json' with { type: 'json' };
import stripes from '@dicebear/styles/stripes.json' with { type: 'json' };
import thumbs from '@dicebear/styles/thumbs.json' with { type: 'json' };
import toonHead from '@dicebear/styles/toon-head.json' with { type: 'json' };
import triangles from '@dicebear/styles/triangles.json' with { type: 'json' };
import { getPaths } from '@monad/home';
import { avatarCacheKey, DEFAULT_AVATAR_STYLE, isAvatarStyle } from '@monad/protocol';
import { Elysia } from 'elysia';

// Styles are statically imported (rather than resolved from the `style` query param via a dynamic
// import) both because @dicebear/styles only publishes this fixed set and to keep the render path
// free of any attacker-controlled module specifier.
const STYLE_DEFINITIONS: Record<AvatarStyle, unknown> = {
  adventurer,
  'adventurer-neutral': adventurerNeutral,
  avataaars,
  'avataaars-neutral': avataaarsNeutral,
  'big-ears': bigEars,
  'big-ears-neutral': bigEarsNeutral,
  'big-smile': bigSmile,
  bottts,
  'bottts-neutral': botttsNeutral,
  croodles,
  'croodles-neutral': croodlesNeutral,
  disco,
  dylan,
  'fun-emoji': funEmoji,
  glass,
  glyphs,
  icons,
  identicon,
  'initial-face': initialFace,
  initials,
  lorelei: loreleiStyle,
  'lorelei-neutral': loreleiNeutral,
  micah,
  miniavs,
  notionists,
  'notionists-neutral': notionistsNeutral,
  'open-peeps': openPeeps,
  personas,
  'pixel-art': pixelArt,
  'pixel-art-neutral': pixelArtNeutral,
  rings,
  'shape-grid': shapeGrid,
  shapes,
  stripes,
  thumbs,
  'toon-head': toonHead,
  triangles
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
