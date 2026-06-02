import { test } from 'bun:test';

import { runAgentCredentialExecution } from './agent-credential-execution.shared.ts';

test.skipIf(process.platform === 'win32')(
  'agent credential execution uses only the sentinel over Unix socket',
  async () => {
    await runAgentCredentialExecution('unix');
  }
);
