import type { Participant } from '../../src/workspace-experiences/experience/types.ts';

import { expect, test } from 'bun:test';

import {
  meshAgentProductDisplayName,
  productIcon
} from '../../src/workspace-experiences/experience/project-members.ts';

test('productIcon resolves every branded MeshAgent product id including openclaw and hermes', () => {
  const ids: Participant['icon'][] = ['codex', 'claude-code', 'gemini', 'gemini-cli', 'qwen', 'openclaw', 'hermes'];
  for (const id of ids) {
    expect(productIcon(id)).toBe(id);
  }
});

test('productIcon rejects unknown or non-string values', () => {
  expect(productIcon('unknown')).toBeUndefined();
  expect(productIcon(42)).toBeUndefined();
});

test('meshAgentProductDisplayName brands openclaw and hermes instead of falling back', () => {
  expect(meshAgentProductDisplayName('openclaw', 'openclaw', 'fallback')).toBe('OpenClaw');
  expect(meshAgentProductDisplayName('hermes', 'hermes', 'fallback')).toBe('Hermes');
  expect(meshAgentProductDisplayName('codex', 'codex', 'fallback')).toBe('OpenAI Codex');
  expect(meshAgentProductDisplayName(undefined, 'unknown', 'Custom CLI')).toBe('Custom CLI');
});
