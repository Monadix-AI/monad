import type { Participant } from '../../src/workplace-experiences/experience/types.ts';

import { expect, test } from 'bun:test';

import {
  meshAgentProductDisplayName,
  productIcon
} from '../../src/workplace-experiences/experience/project-members.ts';

test('productIcon resolves every branded MeshAgent product id', () => {
  const ids: Participant['icon'][] = [
    'codex',
    'claude-code',
    'antigravity',
    'gemini',
    'gemini-cli',
    'qwen',
    'openclaw',
    'hermes'
  ];
  for (const id of ids) {
    expect(productIcon(id)).toBe(id);
  }
});

test('productIcon rejects unknown or non-string values', () => {
  expect(productIcon('unknown')).toBeUndefined();
  expect(productIcon(42)).toBeUndefined();
});

test('meshAgentProductDisplayName uses official product names instead of falling back', () => {
  expect(meshAgentProductDisplayName('antigravity', 'antigravity', 'fallback')).toBe('Antigravity');
  expect(meshAgentProductDisplayName('openclaw', 'openclaw', 'fallback')).toBe('OpenClaw');
  expect(meshAgentProductDisplayName('hermes', 'hermes', 'fallback')).toBe('Hermes');
  expect(meshAgentProductDisplayName('codex', 'codex', 'fallback')).toBe('OpenAI Codex');
  expect(meshAgentProductDisplayName(undefined, 'unknown', 'Custom CLI')).toBe('Custom CLI');
});
