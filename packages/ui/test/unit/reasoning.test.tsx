import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { Reasoning, ReasoningContent, ReasoningTrigger } from '../../src/components/AIElements';

function renderReasoning(isStreaming: boolean): string {
  return renderToStaticMarkup(
    <Reasoning
      defaultOpen
      isStreaming={isStreaming}
    >
      <ReasoningTrigger />
      <ReasoningContent>Checking the current state.</ReasoningContent>
    </Reasoning>
  );
}

test('streaming reasoning uses a solving orb as its live status indicator', () => {
  const markup = renderReasoning(true);

  expect({
    hidden: markup.includes('aria-hidden="true"'),
    label: /<canvas[^>]+aria-label="([^"]+)"/.exec(markup)?.[1],
    orbCount: markup.match(/<canvas/g)?.length ?? 0,
    state: /<canvas[^>]+data-orb-state="([^"]+)"/.exec(markup)?.[1],
    text: markup.includes('Thinking... 0s')
  }).toEqual({
    hidden: true,
    label: 'Solving…',
    orbCount: 1,
    state: 'solving',
    text: true
  });
});

test('completed reasoning returns to the static status icon', () => {
  const markup = renderReasoning(false);

  expect(markup.match(/<canvas/g) ?? []).toHaveLength(0);
  expect(markup).toContain('Thought for');
});

test('completed zero-duration reasoning never falls back to the streaming label', () => {
  const markup = renderToStaticMarkup(
    <Reasoning
      defaultOpen
      duration={0}
      isStreaming={false}
    >
      <ReasoningTrigger />
      <ReasoningContent>Finished immediately.</ReasoningContent>
    </Reasoning>
  );

  expect({
    completed: markup.includes('Thought for 0s'),
    streaming: markup.includes('Thinking...')
  }).toEqual({ completed: true, streaming: false });
});
