import type { PendingInteraction } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { collectInteractionValues, interactionRequiredJson } from '../../src/interactions/presenter.ts';

const interaction: PendingInteraction = {
  id: 'interaction-1',
  source: { kind: 'atom-pack', packId: 'vendor.pack', atomId: 'cloud' },
  request: {
    type: 'form',
    title: 'Configure',
    fields: [
      { id: 'name', type: 'string', label: 'Name' },
      { id: 'apiKey', type: 'secret', label: 'API key' },
      { id: 'count', type: 'number', label: 'Count' },
      { id: 'enabled', type: 'boolean', label: 'Enabled' },
      { id: 'region', type: 'select', label: 'Region', options: [{ value: 'us', label: 'US' }] }
    ]
  },
  mode: 'background',
  state: 'pending',
  createdAt: '2026-07-13T00:00:00.000Z',
  expiresAt: '2026-07-13T00:05:00.000Z'
};

test('collects all field types and routes secrets through the no-echo method', async () => {
  const calls: string[] = [];
  const values = await collectInteractionValues(interaction, {
    text: async (label) => {
      calls.push(`text:${label}`);
      return label === 'Name' ? 'demo' : '2';
    },
    secret: async (label) => {
      calls.push(`secret:${label}`);
      return 'secret-value';
    },
    confirm: async (label) => {
      calls.push(`confirm:${label}`);
      return true;
    },
    select: async (label, options) => {
      calls.push(`select:${label}:${options.length}`);
      return options[0]?.value ?? '';
    }
  });

  expect(values).toEqual({ name: 'demo', apiKey: 'secret-value', count: 2, enabled: true, region: 'us' });
  expect(calls).toContain('secret:API key');
  expect(calls).not.toContain('text:API key');
});

test('non-interactive output contains only the resumable id and trusted attribution', () => {
  const output = interactionRequiredJson(interaction);

  expect(output).toEqual({
    status: 'interaction_required',
    interactionId: 'interaction-1',
    source: { kind: 'atom-pack', packId: 'vendor.pack', atomId: 'cloud' },
    title: 'Configure'
  });
  expect(JSON.stringify(output)).not.toContain('secret-value');
});
