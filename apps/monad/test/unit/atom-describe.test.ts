import { expect, test } from 'bun:test';
import builtinAtomPack from '@monad/atoms';
import { monadPowerPack } from '@monad/monad-power-pack';

import { describeAtomPack } from '#/atoms/describe.ts';

test('describeAtomPack enumerates each individual atom of the built-in pack', async () => {
  const atoms = await describeAtomPack(builtinAtomPack);

  expect([...new Set(atoms.map((atom) => atom.kind))]).toEqual([
    'connector',
    'channel',
    'command',
    'provider',
    'agent-adapter',
    'workspace-experience'
  ]);

  // Concrete atoms are identified, not just their kind.
  const channelIds = atoms.filter((a) => a.kind === 'channel').map((a) => a.id);
  expect(channelIds).toContain('telegram');
  expect(channelIds.length).toBeGreaterThan(1);

  // Commands carry their human description.
  const newCommand = atoms.find((a) => a.kind === 'command' && a.id === 'new');
  expect(newCommand).toEqual({ kind: 'command', id: 'new', description: 'Start a new conversation' });
});

test('describeAtomPack enumerates the power pack sandbox launchers', async () => {
  const atoms = await describeAtomPack(monadPowerPack);

  expect(atoms.filter((atom) => atom.kind === 'sandbox')).toEqual([
    {
      kind: 'sandbox',
      id: 'docker',
      name: 'Docker / Podman',
      description: 'Runs each command in an isolated local container.'
    },
    {
      kind: 'sandbox',
      id: 'e2b',
      name: 'E2B',
      description: 'Runs commands in a reusable remote micro-VM.'
    }
  ]);
});
