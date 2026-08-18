import { expect, test } from 'bun:test';
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@monad/ui';
import { fireEvent, render } from '@testing-library/react';

import { setupDomTestEnvironment } from '../dom-test-env.ts';

setupDomTestEnvironment();

function reasoningCard(text: string) {
  return (
    <Reasoning isStreaming>
      <ReasoningTrigger />
      <ReasoningContent>{text}</ReasoningContent>
    </Reasoning>
  );
}

test('reasoning stays collapsed while it streams and only the reader opens it', () => {
  const view = render(reasoningCard('Chec'));
  const trigger = view.getByRole('button');
  const onStreamStart = trigger.getAttribute('aria-expanded');

  view.rerender(reasoningCard('Checking the repository'));
  const afterMoreReasoning = trigger.getAttribute('aria-expanded');
  fireEvent.click(trigger);
  const openedByReader = trigger.getAttribute('aria-expanded');
  view.rerender(reasoningCard('Checking the repository and its tests'));

  expect({
    onStreamStart,
    afterMoreReasoning,
    openedByReader,
    keptOpenWhileStreaming: trigger.getAttribute('aria-expanded')
  }).toEqual({
    onStreamStart: 'false',
    afterMoreReasoning: 'false',
    openedByReader: 'true',
    keptOpenWhileStreaming: 'true'
  });
  view.unmount();
});

test('a reader-opened reasoning card stays open after the stream settles', () => {
  const view = render(reasoningCard('Checking'));
  const trigger = view.getByRole('button');
  fireEvent.click(trigger);
  view.rerender(
    <Reasoning duration={4}>
      <ReasoningTrigger />
      <ReasoningContent>Checking the repository</ReasoningContent>
    </Reasoning>
  );

  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  view.unmount();
});
