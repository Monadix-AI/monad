import { describe, expect, test } from 'bun:test';

import { sessionApprovalChoices, sessionApprovalDecision } from '../../src/features/session/session-approval-sheet';

const labels = {
  agent: 'This agent',
  deny: 'Deny',
  global: 'Always',
  once: 'Allow once',
  session: 'This session'
};

describe('session approval sheet choices', () => {
  test('builds the exact ordered legacy approval contract and resolves selections', () => {
    const choices = sessionApprovalChoices(
      {
        requestId: 'approval-1',
        tool: 'shell'
      },
      labels
    );

    expect(choices).toEqual([
      { id: 'allow:once', label: 'Allow once' },
      { id: 'allow:session', label: 'This session' },
      { id: 'allow:global', label: 'Always' },
      { id: 'deny', label: 'Deny', tone: 'danger' }
    ]);
    const sessionChoice = choices.find((choice) => choice.id === 'allow:session');
    const denyChoice = choices.find((choice) => choice.id === 'deny');
    if (!sessionChoice || !denyChoice) throw new Error('expected session and deny choices');
    expect(sessionApprovalDecision(sessionChoice)).toEqual({
      allow: true,
      scope: 'session'
    });
    expect(sessionApprovalDecision(denyChoice)).toEqual({
      allow: false,
      reason: 'denied by operator',
      scope: 'once'
    });
  });

  test('uses resource scopes and excludes global host-control approval', () => {
    const choices = sessionApprovalChoices(
      {
        display: {
          defaultScope: 'agent',
          kind: 'resource-approval',
          rememberScopes: ['once', 'agent', 'global'],
          resource: 'path',
          subject: '/tmp/project'
        },
        key: 'host-control',
        requestId: 'approval-2',
        tool: 'path_access'
      },
      labels
    );

    expect(choices).toEqual([
      { id: 'allow:agent', label: 'This agent' },
      { id: 'allow:once', label: 'Allow once' },
      { id: 'deny', label: 'Deny', tone: 'danger' }
    ]);
  });
});
