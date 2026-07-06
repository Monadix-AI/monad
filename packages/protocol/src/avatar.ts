import { z } from 'zod';

// The full set of avatar styles bundled by @dicebear/styles (https://www.dicebear.com/licenses/),
// offered as a profile-picture choice. AVATAR_STYLE_SLUGS is GENERATED from the installed package
// (`bun run protocol:avatar-styles`) — not hand-maintained — and is the one source of truth for the
// style SET: the wire enum below and the static imports in avatar-cache.ts both derive from it
// (avatar-cache's `Record<AvatarStyle, …>` is compile-time-locked to this union, so a missing/extra
// style is a type error). `apps/monad/test/unit/avatar-styles.test.ts` asserts the generated list
// still equals the installed package, so a @dicebear/styles upgrade that adds/drops a style fails a
// test until the file is regenerated.
import { AVATAR_STYLE_SLUGS } from '../generated/avatar-styles.ts';

export { AVATAR_STYLE_SLUGS };

export type AvatarStyle = (typeof AVATAR_STYLE_SLUGS)[number];

export const DEFAULT_AVATAR_STYLE: AvatarStyle = 'notionists';

export const avatarStyleSchema = z.enum(AVATAR_STYLE_SLUGS);

const AVATAR_STYLE_SLUG_SET: ReadonlySet<string> = new Set(AVATAR_STYLE_SLUGS);

export function isAvatarStyle(value: string): value is AvatarStyle {
  return AVATAR_STYLE_SLUG_SET.has(value);
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

// Same URL as the read path — POST is what tells the daemon to persist the render to the on-disk
// cache; GET on this path is read-only and never writes. See apps/monad/src/transports/http/avatar-cache.ts.
export function entityAvatarWriteUrl(seed: string, style: AvatarStyle = DEFAULT_AVATAR_STYLE): string {
  return entityAvatarUrl(seed, style);
}
