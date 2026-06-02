import { expect, test } from 'bun:test';

import { monadMeshConfigSchema, peerSchema } from '../../src/config/index.ts';

test('peer credentials persist directly in mesh settings', () => {
  expect(
    monadMeshConfigSchema.parse({
      version: 1,
      peers: [
        {
          id: 'peer_HOME00000000',
          label: 'Home',
          baseUrl: 'https://peer.example.com/openai',
          credential: { token: 'canary-token' }
        }
      ]
    }).peers[0]
  ).toEqual({
    id: 'peer_HOME00000000',
    label: 'Home',
    baseUrl: 'https://peer.example.com/openai',
    defaultAgent: 'default',
    credential: { token: 'canary-token' },
    enabled: false
  });
});

test('peer credential rejects removed secret-reference syntax', () => {
  expect(
    peerSchema.safeParse({
      id: 'peer_HOME00000000',
      label: 'Home',
      baseUrl: 'https://peer.example.com/openai',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: rejection test uses the literal legacy syntax
      credential: { token: '${secret:peer/peer_HOME00000000/token}' }
    }).success
  ).toBe(false);
});
