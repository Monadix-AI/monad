import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { zhMessages } from '../../src/messages.ts';
import { createI18n } from '../../src/runtime.ts';

const runtimePath = join(import.meta.dir, '..', '..', 'src', 'runtime.ts');

test('runtime built-ins do not statically import Paraglide generated modules', async () => {
  const runtimeSource = await readFile(runtimePath, 'utf8');
  expect(runtimeSource).not.toContain('generated/paraglide');

  const { t } = createI18n({ locale: 'zh', packs: [] });
  expect(t('cmd.new.started')).toBe(zhMessages['cmd.new.started'] ?? '');
});
