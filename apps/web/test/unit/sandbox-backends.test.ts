import type { SandboxBackendView } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { groupSandboxBackends } from '../../src/features/studio/sandbox/BackendCards.tsx';
import { buildActivationSettings, initialSchemaValues } from '../../src/features/studio/sandbox/SchemaSettingsForm.tsx';

const builtin: SandboxBackendView = {
  ref: { source: 'builtin', kind: 'vm' },
  descriptor: { name: 'Virtual machine' },
  sourceLabel: 'Built-in',
  status: 'available',
  settings: {}
};
const contributed: SandboxBackendView = {
  ref: { source: 'atom-pack', packId: 'vendor-pack', kind: 'cloud' },
  descriptor: { name: 'Cloud' },
  sourceLabel: 'vendor-pack',
  status: 'unavailable',
  settings: {}
};

test('groups built-in and installed backends without branching on contributed kinds', () => {
  expect(groupSandboxBackends([contributed, builtin])).toEqual({ builtin: [builtin], installed: [contributed] });
});

test('builds defaults for every declarative field type and preserves configured secret state', () => {
  const backend: SandboxBackendView = {
    ...contributed,
    descriptor: {
      name: 'Schema backend',
      settings: {
        fields: [
          { id: 'name', type: 'string', label: 'Name', defaultValue: 'demo' },
          { id: 'token', type: 'secret', label: 'Token', required: true },
          { id: 'workers', type: 'number', label: 'Workers', defaultValue: 2 },
          { id: 'enabled', type: 'boolean', label: 'Enabled', defaultValue: true },
          {
            id: 'region',
            type: 'select',
            label: 'Region',
            defaultValue: 'east',
            options: [{ value: 'east', label: 'East' }]
          }
        ]
      }
    },
    settings: { token: { configured: true } }
  };

  expect(initialSchemaValues(backend)).toEqual({
    name: 'demo',
    token: { configured: true },
    workers: 2,
    enabled: true,
    region: 'east'
  });
});

test('secret fields use explicit replace/remove operations and never enter normal values', () => {
  const settings = buildActivationSettings(
    { image: 'custom', apiKey: '' },
    { apiKey: { action: 'replace', value: 'secret-value' } }
  );
  expect(settings).toEqual({
    values: { image: 'custom' },
    secrets: { apiKey: { action: 'replace', value: 'secret-value' } }
  });
  expect(JSON.stringify(settings.values)).not.toContain('secret-value');
});
