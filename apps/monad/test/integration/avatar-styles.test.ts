import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AVATAR_STYLE_SLUGS } from '@monad/protocol';

// The protocol enum is the hand-maintained source of truth for the style SET (the wire schema needs
// an explicit literal union, and avatar-cache's `Record<AvatarStyle, …>` is compile-time-locked to
// it). This asserts it equals the styles the installed @dicebear/styles package actually ships, so a
// package upgrade that adds or drops a style fails here instead of drifting silently — the one sync
// the type system can't enforce.
test('protocol avatar styles match the installed @dicebear/styles package', () => {
  const stylesDir = dirname(Bun.resolveSync('@dicebear/styles/adventurer.json', import.meta.dir));
  const packageSlugs = readdirSync(stylesDir)
    .filter((file) => file.endsWith('.min.json'))
    .map((file) => file.slice(0, -'.min.json'.length))
    .sort();

  const protocolSlugs: string[] = [...AVATAR_STYLE_SLUGS].sort();
  expect(packageSlugs.length).toBeGreaterThan(0);
  expect(protocolSlugs).toEqual(packageSlugs);
});
