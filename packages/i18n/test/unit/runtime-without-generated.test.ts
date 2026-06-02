import { expect, test } from 'bun:test';

import { zhMessages } from '../../src/messages.ts';
import { createI18n } from '../../src/runtime.ts';

test('runtime resolves built-in Chinese messages', () => {
  const { t } = createI18n({ locale: 'zh', packs: [] });
  expect(t('cmd.new.started')).toBe(zhMessages['cmd.new.started'] ?? '');
});
