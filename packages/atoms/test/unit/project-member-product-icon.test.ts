import type { Participant } from '../../src/workspace-experiences/experience/types.ts';

import { expect, test } from 'bun:test';

import {
  externalAgentProductDisplayName,
  productIcon
} from '../../src/workspace-experiences/experience/project-members.ts';

test('productIcon resolves every branded external agent product id including openclaw and hermes', () => {
  const ids: Participant['icon'][] = ['codex', 'claude-code', 'gemini', 'gemini-cli', 'qwen', 'openclaw', 'hermes'];
  for (const id of ids) {
    expect(productIcon(id)).toBe(id);
  }
});

test('productIcon rejects unknown or non-string values', () => {});

test('externalAgentProductDisplayName brands openclaw and hermes instead of falling back', () => {
  expect(externalAgentProductDisplayName('openclaw', 'openclaw', 'fallback')).toBe('OpenClaw');
  expect(externalAgentProductDisplayName('hermes', 'hermes', 'fallback')).toBe('Hermes');
  expect(externalAgentProductDisplayName('codex', 'codex', 'fallback')).toBe('OpenAI Codex');
  expect(externalAgentProductDisplayName(undefined, 'unknown', 'Custom CLI')).toBe('Custom CLI');
});
