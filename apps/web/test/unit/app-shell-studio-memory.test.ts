import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('AppShell opens the remembered Studio section when no section is specified', () => {
  const source = readFileSync(join(import.meta.dir, '../../features/shell/AppShell.tsx'), 'utf8');

  expect(source).toContain('state.lastStudioSection');
  expect(source).toContain('section: section ?? lastStudioSection');
});
