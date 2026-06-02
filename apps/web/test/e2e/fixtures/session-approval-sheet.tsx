import type { ApprovalScope } from '@monad/protocol';
import type { PendingApproval } from '../../../src/features/session/session-route-contract';

import { useState } from 'react';
import { createRoot } from 'react-dom/client';

import { SessionApprovalSheet } from '../../../src/features/session/SessionApprovalSheet';
import '../../../src/styles/globals.css';

type Result = {
  allow: boolean;
  reason?: string;
  requestId: string;
  scope: ApprovalScope;
};

const initialApprovals: PendingApproval[] = [
  {
    input: { command: 'git status' },
    requestId: 'approval-1',
    tool: 'shell'
  },
  {
    display: {
      defaultScope: 'once',
      kind: 'resource-approval',
      rememberScopes: ['once', 'session'],
      resource: 'network',
      subject: 'api.example.com'
    },
    requestId: 'approval-2',
    tool: 'network_access'
  }
];

function Harness(): React.ReactElement {
  const [pending, setPending] = useState(initialApprovals);
  const [results, setResults] = useState<Result[]>([]);
  const approval = pending[0];

  return (
    <main className="mx-auto my-12 max-w-2xl">
      {approval ? (
        <SessionApprovalSheet
          agentLabel="Codex"
          approval={approval}
          key={approval.requestId}
          onApproval={(item, allow, scope, reason) => {
            setResults((current) => [
              ...current,
              { allow, requestId: item.requestId, scope, ...(reason ? { reason } : {}) }
            ]);
            setPending((current) => current.slice(1));
          }}
          position={1}
          total={pending.length}
        />
      ) : null}
      <output aria-label="Result">{JSON.stringify(results)}</output>
    </main>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<Harness />);
