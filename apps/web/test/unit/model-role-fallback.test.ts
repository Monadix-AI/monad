import type { ModelModalities } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { roleFallbackLabelKey } from '../../src/features/studio/model-settings/role-fallback';

const vision = (c?: ModelModalities) => !!c?.input?.includes('image');

test('role fallback label only uses default model when capabilities are known to match', () => {
  expect(roleFallbackLabelKey(undefined, vision)).toBe('web.model.roleNotAvailable');
  expect(roleFallbackLabelKey({ kind: 'chat', input: ['text'], output: ['text'] }, vision)).toBe(
    'web.model.roleNotAvailable'
  );
  expect(roleFallbackLabelKey({ kind: 'chat', input: ['text', 'image'], output: ['text'] }, vision)).toBe(
    'web.model.useDefaultModel'
  );
});
