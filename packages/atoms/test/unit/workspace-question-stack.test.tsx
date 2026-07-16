import { expect, test } from 'bun:test';

import { QuestionStack } from '../../src/workspace-experiences/chat-room/components/composer/question-stack.tsx';

test('QuestionStack remounts the ask sheet for each question', () => {
  const question = {
    id: 'clarify_next',
    askerName: 'Codex',
    question: 'Choose the next step',
    options: ['Ship', 'Revise'],
    mode: 'single' as const,
    allowOther: true
  };
  const element = QuestionStack({
    onAnswer: () => {},
    onDismiss: () => {},
    position: 2,
    question,
    total: 2
  });

  expect(element.key).toBe(question.id);
});
