import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  deferredEffortCommit,
  ReasoningEffortControl,
  reasoningEffortOption,
  resolveReasoningEffort
} from '../../src/components/ReasoningEffortControl.tsx';

test('reasoning effort requires probed options and never invents a default selection', () => {
  expect(resolveReasoningEffort(undefined, 'medium')).toEqual({ efforts: [], value: undefined });
  expect(resolveReasoningEffort([], 'medium')).toEqual({ efforts: [], value: undefined });
  expect(resolveReasoningEffort(['low', 'medium', 'high'])).toEqual({
    efforts: ['low', 'medium', 'high'],
    value: undefined
  });
  expect(resolveReasoningEffort(['low', 'medium', 'high'], 'xhigh', 'medium')).toEqual({
    efforts: ['low', 'medium', 'high'],
    value: 'medium'
  });
});

test('reasoning effort preserves provider probe order', () => {
  expect(resolveReasoningEffort(['max', 'xhigh', 'high']).efforts).toEqual(['max', 'xhigh', 'high']);
  expect(resolveReasoningEffort(['deep', 'light']).efforts).toEqual(['deep', 'light']);
});

test('reasoning effort commits only when its popover closes with a changed draft', () => {
  expect(deferredEffortCommit(true, 'low', 'high')).toBeNull();
  expect(deferredEffortCommit(false, 'low', 'low')).toBeNull();
  expect(deferredEffortCommit(false, 'low', 'high')).toEqual({ value: 'high' });
});

test('reasoning effort labels an unset value as Default', () => {
  const markup = renderToStaticMarkup(
    createElement(ReasoningEffortControl, {
      onChange: () => undefined,
      options: ['low', 'medium', 'high'].map(reasoningEffortOption),
      value: undefined
    })
  );

  expect(markup.replace(/<[^>]+>/g, '')).toBe('EffortDefaultFastSmart');
});
