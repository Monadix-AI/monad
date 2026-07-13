import { expect, test } from 'bun:test';

import { interactionToAcpElicitation } from '#/transports/acp/bridges.ts';

test('maps all ACP-compatible interaction fields to a closed object schema', () => {
  const result = interactionToAcpElicitation(
    {
      type: 'form',
      title: 'Configure backend',
      fields: [
        { id: 'name', type: 'string', label: 'Name', required: true, pattern: '^[a-z]+$' },
        { id: 'retries', type: 'number', label: 'Retries', min: 0, max: 5 },
        { id: 'enabled', type: 'boolean', label: 'Enabled' },
        {
          id: 'region',
          type: 'select',
          label: 'Region',
          options: [
            { value: 'us', label: 'US' },
            { value: 'eu', label: 'EU' }
          ]
        }
      ]
    },
    { kind: 'atom-pack', packId: 'docker-pack', atomId: 'docker' },
    'ses_1'
  );

  expect(result).toEqual({
    mode: 'form',
    sessionId: 'ses_1',
    message: '[docker-pack / docker] Configure backend',
    requestedSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', title: 'Name', pattern: '^[a-z]+$' },
        retries: { type: 'number', title: 'Retries', minimum: 0, maximum: 5 },
        enabled: { type: 'boolean', title: 'Enabled' },
        region: {
          type: 'string',
          title: 'Region',
          oneOf: [
            { const: 'us', title: 'US' },
            { const: 'eu', title: 'EU' }
          ]
        }
      },
      required: ['name']
    }
  });
});

test('explicitly refuses secret fields that ACP cannot safely render', () => {
  expect(() =>
    interactionToAcpElicitation(
      { type: 'form', title: 'Credentials', fields: [{ id: 'token', type: 'secret', label: 'Token' }] },
      { kind: 'builtin', id: 'settings' },
      'ses_1'
    )
  ).toThrow('ACP presenter does not support secret fields');
});
