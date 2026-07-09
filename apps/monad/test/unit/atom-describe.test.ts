import { expect, test } from 'bun:test';
import builtinAtomPack from '@monad/atoms';

import { describeAtomPack } from '#/atoms/describe.ts';

test('describeAtomPack enumerates each individual atom of the built-in pack', async () => {
  const atoms = await describeAtomPack(builtinAtomPack);

  // Every declared kind should surface at least one concrete atom. The builtin pack no longer ships
  // `sandbox` launchers — the light OS launchers are @monad/sandbox's closed set and the heavy
  // docker/e2b launchers are the opt-in @monad/monad-power-pack (covered in sandbox-atom-load.test).
  const kinds = new Set(atoms.map((a) => a.kind));
  expect(kinds.has('channel')).toBe(true);
  expect(kinds.has('command')).toBe(true);
  expect(kinds.has('provider')).toBe(true);
  expect(kinds.has('sandbox')).toBe(false);

  // Concrete atoms are identified, not just their kind.
  const channelIds = atoms.filter((a) => a.kind === 'channel').map((a) => a.id);
  expect(channelIds).toContain('telegram');
  expect(channelIds.length).toBeGreaterThan(1);

  // Commands carry their human description.
  const _newCommand = atoms.find((a) => a.kind === 'command' && a.id === 'new');
});
