import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('Windows smoke exposes a fail-closed real conformance mode', async () => {
  const script = await Bun.file(join(import.meta.dir, '../smoke/winvm-helper.ps1')).text();

  expect(script).toContain('[switch]$Conformance');
  expect(script).toContain("if (-not $probe.hyperv) { Die 'cannot run conformance");
  expect(script).toContain("if (-not $reg.registered) { Die 'cannot run conformance");
  expect(script).toContain("$env:MONAD_VM_IT = '1'");
  expect(script).toContain('& bun run test:e2e');
});
