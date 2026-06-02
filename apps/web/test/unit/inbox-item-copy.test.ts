import { expect, test } from 'bun:test';

import { inboxApprovalAction } from '../../src/features/inbox/InboxItemRow';

const base = {
  actionState: 'needs-response' as const,
  approvalKind: 'mesh-agent' as const,
  createdAt: '2026-08-03T00:00:00.000Z',
  id: 'gate_123',
  itemKey: 'approval:gate_123',
  kind: 'approval' as const,
  meshSessionId: 'mesh_ABCDEF123456' as const,
  provider: 'monad',
  sessionId: 'ses_ABCDEF123456' as const
};

test('Inbox approval copy names the concrete tool and falls back from opaque provider text', () => {
  expect([
    inboxApprovalAction(
      {
        ...base,
        input: { requestId: 'gate_123', kind: 'tool', tool: 'monad__project_post', input: { text: 'Hello' } },
        text: 'tool'
      },
      'Approval request'
    ),
    inboxApprovalAction({ ...base, text: 'Run the deployment' }, 'Approval request'),
    inboxApprovalAction(base, 'Approval request')
  ]).toEqual(['monad__project_post', 'Run the deployment', 'Approval request']);
});
