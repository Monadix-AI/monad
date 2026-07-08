import { expect, test } from 'bun:test';

import { approvalActionScopes } from '../../features/session/approval-display';

test('approvalActionScopes uses rememberScopes and moves defaultScope first', () => {
  expect(
    approvalActionScopes({
      kind: 'resource-approval',
      resource: 'path',
      subject: '/tmp/outside',
      defaultScope: 'session',
      rememberScopes: ['once', 'session']
    })
  ).toEqual(['session', 'once']);
});

test('approvalActionScopes falls back to legacy approval scopes without display metadata', () => {
  expect(approvalActionScopes(undefined)).toEqual(['once', 'session', 'global']);
});
