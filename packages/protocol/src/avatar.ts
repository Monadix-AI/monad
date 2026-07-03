import { z } from 'zod';

// All avatar styles bundled by @dicebear/styles (https://www.dicebear.com/licenses/), offered as a
// profile picture style choice. This must match the full style set: the server only bundles (and
// can only render) the styles imported below. Adding/removing a slug here also requires updating
// the AVATAR_STYLES list in scripts/generate-licenses.ts and the static imports in avatar-cache.ts.
export const AVATAR_STYLES = [
  { slug: 'adventurer', label: 'Adventurer' },
  { slug: 'adventurer-neutral', label: 'Adventurer Neutral' },
  { slug: 'avataaars', label: 'Avataaars' },
  { slug: 'avataaars-neutral', label: 'Avataaars Neutral' },
  { slug: 'big-ears', label: 'Big Ears' },
  { slug: 'big-ears-neutral', label: 'Big Ears Neutral' },
  { slug: 'big-smile', label: 'Big Smile' },
  { slug: 'bottts', label: 'Bottts' },
  { slug: 'bottts-neutral', label: 'Bottts Neutral' },
  { slug: 'croodles', label: 'Croodles' },
  { slug: 'croodles-neutral', label: 'Croodles Neutral' },
  { slug: 'disco', label: 'Disco' },
  { slug: 'dylan', label: 'Dylan' },
  { slug: 'fun-emoji', label: 'Fun Emoji' },
  { slug: 'glass', label: 'Glass' },
  { slug: 'glyphs', label: 'Glyphs' },
  { slug: 'icons', label: 'Icons' },
  { slug: 'identicon', label: 'Identicon' },
  { slug: 'initial-face', label: 'Initial Face' },
  { slug: 'initials', label: 'Initials' },
  { slug: 'lorelei', label: 'Lorelei' },
  { slug: 'lorelei-neutral', label: 'Lorelei Neutral' },
  { slug: 'micah', label: 'Micah' },
  { slug: 'miniavs', label: 'Miniavs' },
  { slug: 'notionists', label: 'Notionists' },
  { slug: 'notionists-neutral', label: 'Notionists Neutral' },
  { slug: 'open-peeps', label: 'Open Peeps' },
  { slug: 'personas', label: 'Personas' },
  { slug: 'pixel-art', label: 'Pixel Art' },
  { slug: 'pixel-art-neutral', label: 'Pixel Art Neutral' },
  { slug: 'rings', label: 'Rings' },
  { slug: 'shape-grid', label: 'Shape Grid' },
  { slug: 'shapes', label: 'Shapes' },
  { slug: 'stripes', label: 'Stripes' },
  { slug: 'thumbs', label: 'Thumbs' },
  { slug: 'toon-head', label: 'Toon Head' },
  { slug: 'triangles', label: 'Triangles' }
] as const;

export type AvatarStyle = (typeof AVATAR_STYLES)[number]['slug'];

export const DEFAULT_AVATAR_STYLE: AvatarStyle = 'notionists';

const avatarStyleValues = AVATAR_STYLES.map((style) => style.slug) as [AvatarStyle, ...AvatarStyle[]];
export const avatarStyleSchema = z.enum(avatarStyleValues);

const AVATAR_STYLE_SLUGS: ReadonlySet<string> = new Set(AVATAR_STYLES.map((style) => style.slug));

export function isAvatarStyle(value: string): value is AvatarStyle {
  return AVATAR_STYLE_SLUGS.has(value);
}

// Attribution required by each style's license (served via GET /api/v1/licenses alongside npm
// package licenses — see packages/protocol/src/licenses.ts and scripts/generate-licenses.ts, which
// generates this from each style's own `meta` block in @dicebear/styles rather than hand-transcribing
// it, so it can't drift from the actual bundled package). DiceBear itself (the library) is
// MIT-licensed, but several individual styles are remixes of other artists' work under their own
// license (CC BY 4.0, CC0, or a source-specific grant) — this is separate from and in addition to
// the npm package license shown on the licenses page.
export const avatarStyleCreditSchema = z.object({
  slug: z.string(),
  label: z.string(),
  creator: z.string(),
  creatorUrl: z.string().optional(),
  source: z.string(),
  sourceUrl: z.string().optional(),
  license: z.string(),
  licenseUrl: z.string()
});
export type AvatarStyleCredit = z.infer<typeof avatarStyleCreditSchema>;

const AVATAR_CACHE_VERSION = 'v2';

export function avatarCacheKey(seed: string, style: AvatarStyle = DEFAULT_AVATAR_STYLE): string {
  let hash = 5381;
  const input = `${AVATAR_CACHE_VERSION}:${style}:${seed}`;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 33) ^ input.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

export function entityAvatarUrl(seed: string, style: AvatarStyle = DEFAULT_AVATAR_STYLE): string {
  const key = avatarCacheKey(seed, style);
  return `/api/avatar-cache/${key}.svg?seed=${encodeURIComponent(seed)}&style=${encodeURIComponent(style)}`;
}

export function entityAvatarWriteUrl(seed: string, style: AvatarStyle = DEFAULT_AVATAR_STYLE): string {
  return `${entityAvatarUrl(seed, style)}&write=1`;
}
