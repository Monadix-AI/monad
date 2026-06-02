import { expect, test } from 'bun:test';
import { createDefaultConfig } from '@monad/environment';
import { atomRegistriesViewSchema } from '@monad/protocol';

import { atomRegistriesToView, atomRegistryCredentials } from '#/handlers/atom-pack/atom-pack-shared.ts';

test('atom registry consumers read raw GitHub and npm credentials from config.json ownership', () => {
  const cfg = createDefaultConfig('Test');
  cfg.atomRegistries = {
    github: { token: 'github-canary' },
    npm: { token: 'npm-canary', registry: 'https://registry.npmjs.org' }
  };

  expect(atomRegistryCredentials(cfg)).toEqual({
    githubToken: 'github-canary',
    npmToken: 'npm-canary',
    npmRegistry: 'https://registry.npmjs.org'
  });
});

test('atom registry view exposes configured state without raw tokens', () => {
  const cfg = createDefaultConfig('Test');
  cfg.atomRegistries = {
    github: { token: 'github-canary' },
    npm: { token: 'npm-canary', registry: 'https://registry.npmjs.org' }
  };

  const view = atomRegistriesViewSchema.parse(atomRegistriesToView(cfg));
  expect(view).toEqual({
    github: { token: { configured: true } },
    npm: { token: { configured: true }, registry: 'https://registry.npmjs.org' }
  });
  expect(JSON.stringify(view)).not.toContain('canary');
});
