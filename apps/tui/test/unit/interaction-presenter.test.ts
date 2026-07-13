import type { PendingInteraction } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { interactionSourceLabel, summarizeInteractionValue } from '../../src/interactions/presenter.tsx';

const interaction: PendingInteraction = {
  id: 'interaction-1',
  source: { kind: 'atom-pack', packId: 'sandbox-pack', atomId: 'e2b' },
  request: {
    type: 'form',
    title: 'Configure E2B',
    fields: [
      { id: 'apiKey', label: 'API key', type: 'secret', required: true },
      { id: 'region', label: 'Region', type: 'select', options: [{ value: 'us', label: 'US' }] }
    ]
  },
  mode: 'foreground',
  state: 'pending',
  createdAt: '2026-07-13T00:00:00.000Z',
  expiresAt: '2026-07-13T00:05:00.000Z'
};

test('renders a readable atom-pack source label', () => {
  expect(interactionSourceLabel(interaction.source)).toBe('sandbox-pack / e2b');
});

test('never includes a secret value in a TUI summary', () => {
  const secret = interaction.request.type === 'form' ? interaction.request.fields[0] : undefined;
  if (!secret) throw new Error('expected secret field');
  expect(summarizeInteractionValue(secret, 'super-secret')).toBe('********');
  expect(summarizeInteractionValue(secret, '')).toBe('(empty)');
});
