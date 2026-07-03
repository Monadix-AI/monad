import { z } from 'zod';

// Curated subset of DiceBear's avatar styles (https://www.dicebear.com/licenses/) offered as a
// profile picture style choice. Kept as a fixed allowlist rather than the full style set both to
// keep the settings picker manageable and because the server only bundles (and can only render)
// the styles imported below. Adding/removing a slug here also requires updating the AVATAR_STYLES
// list in scripts/generate-licenses.ts and the static imports in avatar-cache.ts.
export const AVATAR_STYLES = [
  { slug: 'notionists', label: 'Notionists' },
  { slug: 'avataaars', label: 'Avataaars' },
  { slug: 'lorelei', label: 'Lorelei' },
  { slug: 'micah', label: 'Micah' },
  { slug: 'open-peeps', label: 'Open Peeps' },
  { slug: 'personas', label: 'Personas' },
  { slug: 'adventurer', label: 'Adventurer' },
  { slug: 'big-smile', label: 'Big Smile' },
  { slug: 'bottts', label: 'Bottts' },
  { slug: 'thumbs', label: 'Thumbs' }
] as const;

export type AvatarStyle = (typeof AVATAR_STYLES)[number]['slug'];

export const DEFAULT_AVATAR_STYLE: AvatarStyle = 'notionists';

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
