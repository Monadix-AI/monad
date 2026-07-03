import { expect, test } from 'bun:test';

import { profileDisplayKey, profileKeysForRename } from '../../features/studio/model-settings/profile-rename';

test('profile rename display keeps the same React key across alias changes', () => {
  const keys = profileKeysForRename({}, 'research', 'writer');

  expect(profileDisplayKey('writer', keys)).toBe('research');
  expect(profileDisplayKey('other', keys)).toBe('other');
});
