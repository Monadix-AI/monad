import { test } from 'bun:test';

import { runCredentialSettings } from './credential-settings.shared.ts';

test('Agent Credential settings persist exact redacted CRUD effects over TCP loopback', async () => {
  await runCredentialSettings('tcp');
});
