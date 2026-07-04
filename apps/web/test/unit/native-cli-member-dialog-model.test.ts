import { expect, test } from 'bun:test';

import { nativeCliModelDisplayName } from '../../features/workplace/project-shell/native-cli-member-dialog-model';

test('native CLI member dialog formats first party model names', () => {
  expect(nativeCliModelDisplayName('gpt-5-codex')).toBe('GPT-5-Codex');
  expect(nativeCliModelDisplayName('claude-opus-4-5')).toBe('Opus 4.5');
  expect(nativeCliModelDisplayName('qwen3-coder')).toBe('qwen3-coder');
});
