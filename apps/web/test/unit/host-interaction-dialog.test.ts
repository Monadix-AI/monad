import type { InteractionProducer, InteractionRequest } from '@monad/protocol';

import { expect, test } from 'bun:test';

import {
  initialInteractionValues,
  interactionProducerLabel,
  validateInteractionValues
} from '#/features/interactions/model';

test('initializes every supported semantic field without inventing a secret default', () => {
  const request: InteractionRequest = {
    type: 'form',
    title: 'Configure',
    fields: [
      { id: 'name', type: 'string', label: 'Name', defaultValue: 'demo' },
      { id: 'apiKey', type: 'secret', label: 'API key' },
      { id: 'count', type: 'number', label: 'Count', defaultValue: 2 },
      { id: 'enabled', type: 'boolean', label: 'Enabled', defaultValue: true },
      {
        id: 'region',
        type: 'select',
        label: 'Region',
        defaultValue: 'eu',
        options: [
          { value: 'us', label: 'US' },
          { value: 'eu', label: 'EU' }
        ]
      }
    ]
  };

  expect(initialInteractionValues(request)).toEqual({
    name: 'demo',
    apiKey: '',
    count: 2,
    enabled: true,
    region: 'eu'
  });
});

test('validates required, pattern, numeric bounds, and select membership declaratively', () => {
  const request: InteractionRequest = {
    type: 'form',
    title: 'Configure',
    fields: [
      { id: 'name', type: 'string', label: 'Name', required: true, pattern: '^[a-z]+$' },
      { id: 'count', type: 'number', label: 'Count', min: 1, max: 3 },
      {
        id: 'region',
        type: 'select',
        label: 'Region',
        options: [{ value: 'us', label: 'US' }]
      }
    ]
  };

  expect(validateInteractionValues(request, { name: 'BAD', count: 4, region: 'unknown' })).toEqual({
    name: 'Invalid format',
    count: 'Must be at most 3',
    region: 'Select a valid option'
  });
  expect(validateInteractionValues(request, { name: 'valid', count: 2, region: 'us' })).toEqual({});
});

test('renders source attribution from trusted source fields', () => {
  const builtin: InteractionProducer = { kind: 'builtin', id: 'sandbox', label: 'Sandbox settings' };
  const contributed: InteractionProducer = { kind: 'atom-pack', packId: 'vendor.pack', atomId: 'cloud' };

  expect(interactionProducerLabel(builtin)).toBe('Sandbox settings');
  expect(interactionProducerLabel(contributed)).toBe('vendor.pack · cloud');
});
