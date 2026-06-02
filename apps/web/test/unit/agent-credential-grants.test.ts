import type { AgentCredentialView } from '@monad/protocol';

import { expect, test } from 'bun:test';

import {
  duplicateGrantedEnvironmentVariables,
  toggleCredentialGrant
} from '#/features/studio/agent-workshop/agent-credential-grants';

const credentials: AgentCredentialView[] = [
  {
    id: 'github-main',
    label: 'GitHub main',
    environmentVariable: 'GITHUB_TOKEN',
    allowedHosts: ['api.github.com'],
    configured: true,
    authorizedAgentIds: []
  },
  {
    id: 'github-backup',
    label: 'GitHub backup',
    environmentVariable: 'GITHUB_TOKEN',
    allowedHosts: ['github.com'],
    configured: true,
    authorizedAgentIds: []
  },
  {
    id: 'linear',
    label: 'Linear',
    environmentVariable: 'LINEAR_TOKEN',
    allowedHosts: ['api.linear.app'],
    configured: true,
    authorizedAgentIds: []
  }
];

test('credential grant selection adds and revokes only credential ids', () => {
  const granted = toggleCredentialGrant(['linear'], 'github-main');
  const revoked = toggleCredentialGrant(granted, 'linear');

  expect({ granted, revoked }).toEqual({
    granted: ['linear', 'github-main'],
    revoked: ['github-main']
  });
});

test('credential grant validation reports duplicate selected environment variables', () => {
  expect(duplicateGrantedEnvironmentVariables(credentials, ['github-main', 'github-backup', 'linear'])).toEqual([
    'GITHUB_TOKEN'
  ]);
  expect(duplicateGrantedEnvironmentVariables(credentials, ['github-main', 'linear'])).toEqual([]);
});
