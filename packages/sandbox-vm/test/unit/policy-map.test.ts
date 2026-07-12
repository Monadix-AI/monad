import { expect, test } from 'bun:test';

import { buildIgnition } from '../../src/ignition.ts';

// egressFor and mountsFor are internal to index.ts; we exercise their observable effects through the
// Ignition config the launcher builds (net mode → firewall rules) and document the fail-closed intent.
// The nested-readDeny rejection is a launcher-level guard verified in the integration test; here we
// pin the net-mode fail-closed default at the ignition layer.

test('net:none produces a drop-all firewall (fail-closed egress)', () => {
  const cfg = buildIgnition({ agentBinaryB64: 'QQ==', mounts: [], egress: { mode: 'none' } });
  const nft = cfg.storage.files.find((f) => (f as { path?: string }).path === '/etc/monad/nftables.conf') as
    | { contents: { source: string } }
    | undefined;
  const rules = Buffer.from((nft?.contents.source ?? '').replace(/^data:;base64,/, ''), 'base64').toString('utf8');
  expect(rules).toContain('policy drop;');
  expect(rules).not.toContain('dport 53'); // no DNS, no proxy — nothing leaves
});
