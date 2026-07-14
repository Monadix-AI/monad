import { expect, test } from 'bun:test';
import { join } from 'node:path';

const docsRoot = join(import.meta.dir, '../../../../docs');

test('SRT parity matrix keeps policy and VM enforcement responsibilities separate', async () => {
  const matrix = await Bun.file(join(docsRoot, 'sandbox-vm-srt-parity.md')).text();

  expect(matrix).toContain('@monad/sandbox` policy layer');
  expect(matrix).toContain('@monad/sandbox-vm` enforcement layer');
  expect(matrix).toContain('Domain allow/deny and DNS rebinding checks');
  expect(matrix).toContain('Filtered guest can reach only DHCP and the host proxy');
  expect(matrix).toContain('best-effort telemetry');
  expect(matrix).toContain('Real-VM evidence: not run');
});

test('sandbox backend guide links the evidence-scoped SRT matrix', async () => {
  const guide = await Bun.file(join(docsRoot, 'usage/sandbox-backends.md')).text();

  expect(guide).toContain('../sandbox-vm-srt-parity.md');
});
