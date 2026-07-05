import type { Participant } from '../../src/workspace-experiences/experience/types.ts';

import { expect, test } from 'bun:test';

import {
  nativeCliProductDisplayName,
  productIcon
} from '../../src/workspace-experiences/experience/project-members.ts';

test('productIcon resolves every branded native-CLI product id including openclaw and hermes', () => {
  const ids: Participant['icon'][] = ['codex', 'claude-code', 'gemini', 'gemini-cli', 'qwen', 'openclaw', 'hermes'];
  for (const id of ids) {
    expect(productIcon(id)).toBe(id);
  }
});

test('productIcon rejects unknown or non-string values', () => {
  expect(productIcon('unknown-cli')).toBeUndefined();
  expect(productIcon(undefined)).toBeUndefined();
  expect(productIcon(42)).toBeUndefined();
});

test('nativeCliProductDisplayName brands openclaw and hermes instead of falling back', () => {
  expect(nativeCliProductDisplayName('openclaw', 'openclaw', 'fallback')).toBe('OpenClaw');
  expect(nativeCliProductDisplayName('hermes', 'hermes', 'fallback')).toBe('Hermes');
  expect(nativeCliProductDisplayName('codex', 'codex', 'fallback')).toBe('OpenAI Codex');
  expect(nativeCliProductDisplayName(undefined, 'unknown', 'Custom CLI')).toBe('Custom CLI');
});
