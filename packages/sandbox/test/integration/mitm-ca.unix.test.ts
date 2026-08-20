import { expect, test } from 'bun:test';
import { statSync } from 'node:fs';

import { createMitmCA, disposeMitmCA } from '../../src/mitm/ca.ts';

test('ephemeral CA files restrict the private key to its owner', async () => {
  const ca = createMitmCA();
  try {
    expect({
      certMode: statSync(ca.caCertPath).mode & 0o777,
      keyMode: statSync(ca.caKeyPath).mode & 0o777
    }).toEqual({ certMode: 0o644, keyMode: 0o600 });
  } finally {
    await disposeMitmCA(ca);
  }
});
