import { expect, test } from 'bun:test';

import { avatarStyleLabel } from '@/lib/avatar-styles';

test('avatarStyleLabel title-cases the slug', () => {
  expect(avatarStyleLabel('adventurer-neutral')).toBe('Adventurer Neutral');
  expect(avatarStyleLabel('fun-emoji')).toBe('Fun Emoji');
  expect(avatarStyleLabel('avataaars')).toBe('Avataaars');
});
