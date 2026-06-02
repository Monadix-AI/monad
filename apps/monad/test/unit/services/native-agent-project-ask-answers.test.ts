import { expect, test } from 'bun:test';

import { parseProjectAskAnswers } from '#/services/native-agent/project-ask-answers.ts';

test('maps one restored multi-question payload to its persisted question ids', () => {
  expect(
    parseProjectAskAnswers(
      [{ id: 'scope' }, { id: 'targets' }],
      JSON.stringify({ scope: 'all packages', targets: ['Codex', 'Claude'] })
    )
  ).toEqual({ scope: 'all packages', targets: ['Codex', 'Claude'] });
});

test('keeps legacy scalar answers compatible with one-question asks', () => {
  expect(parseProjectAskAnswers([{ id: 'q1' }], 'ship it')).toEqual({ q1: 'ship it' });
});
