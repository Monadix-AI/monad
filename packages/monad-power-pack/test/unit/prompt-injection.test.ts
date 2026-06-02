import { expect, test } from 'bun:test';

import { injectExperiencePrompts } from '../../src/experiences/prompt-injection.ts';

test('prompt injection composes stage and role-specific advanced instructions for addressed participants', () => {
  const prompt = injectExperiencePrompts({
    basePrompt: 'Deliver the task.',
    stage: 'build',
    context: { title: 'Authentication' },
    participants: [
      { id: 'pmem_host', label: 'Ada', role: 'host' },
      { id: 'pmem_member', label: 'Lin', role: 'member' }
    ],
    injection: {
      stagePrompts: { build: ({ title }) => `Build ${title}.` },
      advancedPrompts: { host: 'Coordinate and synthesize.', member: 'Implement and report evidence.' }
    }
  });

  expect(prompt).toEqual(
    [
      'Deliver the task.',
      'Stage prompt:\nBuild Authentication.',
      'Advanced prompt for host [Ada (pmem_host)]:\nCoordinate and synthesize.',
      'Advanced prompt for member [Lin (pmem_member)]:\nImplement and report evidence.'
    ].join('\n\n')
  );
});

test('prompt injection is optional and omits role instructions when that slot is empty', () => {
  const basePrompt = 'Deliver the task.';
  const withoutInjection = injectExperiencePrompts({
    basePrompt,
    stage: 'build',
    context: {},
    participants: []
  });
  const withoutMembers = injectExperiencePrompts({
    basePrompt,
    stage: 'build',
    context: {},
    participants: [{ id: 'pmem_host', label: 'Ada', role: 'host' }],
    injection: { advancedPrompts: { member: 'Implement it.' } }
  });

  expect({ withoutInjection, withoutMembers }).toEqual({ withoutInjection: basePrompt, withoutMembers: basePrompt });
});
