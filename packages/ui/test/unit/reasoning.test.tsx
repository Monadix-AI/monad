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

  expect(markup.match(/<canvas/g) ?? []).toHaveLength(1);
  expect(markup).toContain('aria-hidden="true"');
  expect(markup).toContain('Thinking...');
});

test('completed reasoning returns to the static status icon', () => {
  const markup = renderReasoning(false);

  expect(markup.match(/<canvas/g) ?? []).toHaveLength(0);
  expect(markup).toContain('Thought for');
});
