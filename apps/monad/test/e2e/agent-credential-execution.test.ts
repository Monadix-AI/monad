import { test } from 'bun:test';

import { runAgentCredentialExecution } from './agent-credential-execution.shared.ts';

test('agent credential execution uses only the sentinel over TCP loopback', async () => {
  await runAgentCredentialExecution('tcp');
});
