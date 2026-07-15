import { expect, test } from 'bun:test';

import { parseSessionModelSelection, serializeSessionModelSelection } from '#/store/db/session-model-selection.ts';

test('session model and effort share one structured column value', () => {
  const stored = serializeSessionModelSelection({ model: 'openrouter:gpt-5', effort: 'high' });

  expect(stored).toBe('{"model":"openrouter:gpt-5","effort":"high"}');
  expect(parseSessionModelSelection(stored)).toEqual({ model: 'openrouter:gpt-5', effort: 'high' });
});

test('session model selection supports either override without inventing defaults', () => {
  expect(parseSessionModelSelection(serializeSessionModelSelection({ model: 'smart' }))).toEqual({ model: 'smart' });
  expect(parseSessionModelSelection(serializeSessionModelSelection({ effort: 'medium' }))).toEqual({
    effort: 'medium'
  });
  expect(serializeSessionModelSelection({})).toBeNull();
  expect(parseSessionModelSelection(null)).toEqual({});
});

test('session model selection preserves legacy plain model values', () => {
  expect(parseSessionModelSelection('smart')).toEqual({ model: 'smart' });
  expect(parseSessionModelSelection('openrouter:gpt-5')).toEqual({ model: 'openrouter:gpt-5' });
});
