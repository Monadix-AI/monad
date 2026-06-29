import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SECRET_INPUT_PASSWORD_MANAGER_PROPS } from '../../components/studio/ModelSettings/secret-input-props';

test('secret inputs opt out of login password managers', () => {
  expect(SECRET_INPUT_PASSWORD_MANAGER_PROPS).toEqual({
    autoComplete: 'off',
    'data-1p-ignore': 'true',
    'data-1password-ignore': 'true',
    'data-form-type': 'other',
    'data-lpignore': 'true',
    type: 'text'
  });
});

test('settings secret fields avoid native password inputs', () => {
  const root = join(import.meta.dir, '../..');
  const files = [
    'components/ChannelsSettings.tsx',
    'components/ConnectionSettings.tsx',
    'components/InitWizard.tsx',
    'components/OpenaiCompatSettings.tsx',
    'components/studio/ModelSettings/providers.tsx'
  ];

  const nativePasswordInput = /\btype\s*=\s*(?:"password"|'password'|\{\s*["']password["']\s*\})/;
  for (const file of files) {
    expect(readFileSync(join(root, file), 'utf8')).not.toMatch(nativePasswordInput);
  }
});
