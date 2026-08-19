import { setupDomTestEnvironment } from '../dom-test-env.ts';

setupDomTestEnvironment();

import { expect, test } from 'bun:test';
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@monad/ui';
import { fireEvent, render } from '@testing-library/react';

import { LiveEventReplayPanelBoundary } from '#/features/developer/LiveEventReplayPanel.tsx';

function panel(text: string) {
  return (
    <LiveEventReplayPanelBoundary
      meshSessionId="mesh_100000000001"
      source="live"
    >
      <Reasoning isStreaming>
        <ReasoningTrigger />
        <ReasoningContent>{text}</ReasoningContent>
      </Reasoning>
    </LiveEventReplayPanelBoundary>
  );
}

test('an open reasoning card stays open when the replay advances to the next delta', () => {
  const view = render(panel('The user is'));
  const trigger = view.getByRole('button', { name: /Thinking/ });
  fireEvent.click(trigger);
  const beforeDelta = trigger.getAttribute('aria-expanded');

  view.rerender(panel('The user is telling'));

  expect({ beforeDelta, afterDelta: trigger.getAttribute('aria-expanded') }).toEqual({
    beforeDelta: 'true',
    afterDelta: 'true'
  });
  view.unmount();
});
