import type { TuiMemorySuggestion } from '../../src/shell/stream-model.ts';

import { expect, test } from 'bun:test';

import { activeMemorySuggestion } from '../../src/shell/context-notice-model.ts';

test('memory suggestion shows until handled, then stays hidden', () => {
  const suggestion: TuiMemorySuggestion = { id: 's1', scope: { kind: 'agent', id: 'a1' }, facts: ['likes tea'] };
  expect(activeMemorySuggestion(suggestion, null)).toEqual({
    id: 's1',
    scope: { kind: 'agent', id: 'a1' },
    facts: ['likes tea']
  });
  expect(activeMemorySuggestion(suggestion, 's1')).toBeUndefined();
  expect(activeMemorySuggestion(undefined, null)).toBeUndefined();
});
