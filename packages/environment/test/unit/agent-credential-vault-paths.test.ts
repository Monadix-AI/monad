import type { MonadPaths } from '../../src/paths.ts';

import { expect, test } from 'bun:test';

import { agentCredentialVaultDenyRoots } from '../../src/paths.ts';

test.each([
  {
    label: 'macOS single-tree',
    auth: '/Users/test/.monad/credentials/auth.json',
    credentials: '/Users/test/.monad/credentials'
  },
  {
    label: 'Linux XDG',
    auth: '/home/test/.config/monad/auth.json',
    credentials: '/home/test/.config/monad/credentials'
  },
  {
    label: 'Windows owner-local',
    auth: 'C:\\Users\\test\\AppData\\Roaming\\monad\\credentials\\auth.json',
    credentials: 'C:\\Users\\test\\AppData\\Roaming\\monad\\credentials'
  }
])('$label vault policy denies the exact auth target without denying the config root', ({ auth, credentials }) => {
  const paths = { auth, credentials } as MonadPaths;

  expect(agentCredentialVaultDenyRoots(paths)).toEqual([auth, credentials]);
});
