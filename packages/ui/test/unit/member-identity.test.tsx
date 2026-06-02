import { expect, test } from 'bun:test';

import { agentProviderTag } from '../../src/components/MemberIdentity';

test('agent provider tags use product names instead of internal member types', () => {
  expect(['codex', 'claude-code', 'gemini', 'unknown'].map(agentProviderTag)).toEqual([
    'Codex',
    'Claude',
    'Gemini',
    'CLI'
  ]);
});
