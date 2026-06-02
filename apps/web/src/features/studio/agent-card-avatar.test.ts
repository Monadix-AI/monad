import { expect, test } from 'bun:test';
import { agentIdSchema } from '@monad/protocol';

import { agentCardAvatar } from './agent-card-avatar';

test('keeps the generated avatar when an agent is renamed', () => {
  const id = agentIdSchema.parse('agt_1234567890ab');

  const before = agentCardAvatar({ id, name: 'Researcher' }, 'notionists');
  const after = agentCardAvatar({ id, name: 'Investigator' }, 'notionists');

  expect(after).toEqual({
    name: 'Investigator',
    avatarUrl: before.avatarUrl
  });
  expect(before.avatarUrl).toContain('seed=monad-agent%3Aagt_1234567890ab');
});
