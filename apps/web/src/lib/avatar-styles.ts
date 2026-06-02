import type { AvatarStyle } from '@monad/protocol';

import { AVATAR_STYLE_SLUGS } from '@monad/protocol';

// @dicebear/styles ships no display labels — each style's human name is exactly its slug in title
// case ("big-ears-neutral" → "Big Ears Neutral"), so derive it instead of hand-transcribing 37 names.
// This is display-only formatting (not a wire concept), so it lives in the UI app rather than
// @monad/protocol, which stays limited to the wire-contract slug enum.
export function avatarStyleLabel(slug: string): string {
  return slug
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export const AVATAR_STYLES: ReadonlyArray<{ slug: AvatarStyle; label: string }> = AVATAR_STYLE_SLUGS.map((slug) => ({
  slug,
  label: avatarStyleLabel(slug)
}));
