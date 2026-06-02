import { test } from 'bun:test';

import { runCredentialSettings } from './credential-settings.shared.ts';

test.skipIf(process.platform === 'win32')(
  'Agent Credential settings persist exact redacted CRUD effects over the Unix socket',
  async () => {
    await runCredentialSettings('unix');
  }
);
