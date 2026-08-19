import type { AgentObservationEvent } from '@monad/protocol';
import type { ReactElement } from 'react';
import type { AgentObservationCard } from '../../src/workplace-experiences/chat-room/components/observation/card-projection.ts';
import type { ObservationTimelineRow } from '../../src/workplace-experiences/chat-room/components/observation/timeline.tsx';

import { expect, jest, test } from 'bun:test';
import { act, fireEvent, render } from '@testing-library/react';

import {
  createObservationDisclosureStore,
  ObservationDisclosureProvider,
  ObservationDisclosureScope
} from '../../src/workplace-experiences/chat-room/components/observation/disclosure.tsx';
import { MonadMcpLongText } from '../../src/workplace-experiences/chat-room/components/observation/monad-mcp-long-text.tsx';
import { ObservationTimelineRowView } from '../../src/workplace-experiences/chat-room/components/observation/timeline.tsx';
import { setupDomTestEnvironment } from '../dom-test-env.ts';

setupDomTestEnvironment();

const longText = Array.from({ length: 9 }, (_, index) => `Line ${index + 1}`).join('\n');

function tree(store: ReturnType<typeof createObservationDisclosureStore>, scope: string): ReactElement {
  return (
    <ObservationDisclosureProvider store={store}>
      <ObservationDisclosureScope id={scope}>
        <MonadMcpLongText
          disclosureKey="body"
          text={longText}
        />
      </ObservationDisclosureScope>
    </ObservationDisclosureProvider>
  );
}

function observationEntry(
  kind: 'assistant-message' | 'reasoning',
  text: string,
  streaming = true
): ObservationTimelineRow['entries'][number] {
  const rawEvent = { id: 'raw-reasoning-response', type: 'provider-message' };
  const event: AgentObservationEvent = {
    id: `event-${kind}`,
    kind,
    provenance: { contractEvents: [{ provenance: { rawEvents: [rawEvent] } }] },
    streaming,
    text
  };
  const card: AgentObservationCard = {
    id: `card-${kind}`,
    kind: kind === 'reasoning' ? 'reasoning' : 'message',
    payload: { event },
    provenance: event.provenance,
    streaming
  };
  return {
    card,
    contractEvents: event.provenance.contractEvents,
    id: card.id,
    kind: 'public'
  };
}

function reasoningTree(
  store: ReturnType<typeof createObservationDisclosureStore>,
  reasoningText: string,
  responseText?: string,
  streaming = true
): ReactElement {
  const reasoning = observationEntry('reasoning', reasoningText, streaming);
  const response = responseText ? observationEntry('assistant-message', responseText, streaming) : undefined;
  return (
    <ObservationDisclosureProvider store={store}>
      <ObservationTimelineRowView
        provider="codex"
        row={{
          id: response ? `${reasoning.id}:${response.id}` : reasoning.id,
          entries: response ? [reasoning, response] : [reasoning]
        }}
      />
    </ObservationDisclosureProvider>
  );
}

test('an expanded card returns expanded after the virtualized row unmounts and remounts', async () => {
  const store = createObservationDisclosureStore();
  const mounted = render(tree(store, 'row-1'));
  fireEvent.click(mounted.getByRole('button'));
  mounted.unmount();

  const remounted = render(tree(store, 'row-1'));
  const afterRemount = remounted.getByRole('button').getAttribute('aria-expanded') === 'true';

  expect(afterRemount).toBe(true);
});

test('expanding one row leaves another row collapsed', async () => {
  const store = createObservationDisclosureStore();
  const expandedRow = render(tree(store, 'row-1'));
  fireEvent.click(expandedRow.getByRole('button'));
  expandedRow.unmount();

  const otherRow = render(tree(store, 'row-2'));
  const neighbourExpanded = otherRow.getByRole('button').getAttribute('aria-expanded') === 'true';

  expect(neighbourExpanded).toBe(false);
});

test('expanded reasoning remains open when streaming adds content and pairs the response', () => {
  const store = createObservationDisclosureStore();
  const mounted = render(reasoningTree(store, 'First reasoning update'));
  fireEvent.click(mounted.getByRole('button'));
  mounted.unmount();

  const remounted = render(
    reasoningTree(store, 'First reasoning update and another one', 'The response has started streaming')
  );

  expect({
    expanded: remounted.getByRole('button').getAttribute('aria-expanded'),
    reasoning: remounted.getByText('First reasoning update and another one').textContent,
    response: remounted.getByText('The response has started streaming').textContent
  }).toEqual({
    expanded: 'true',
    reasoning: 'First reasoning update and another one',
    response: 'The response has started streaming'
  });
});

test('expanded observation reasoning stays open when history loading recomputes it as complete', () => {
  jest.useFakeTimers();
  try {
    const store = createObservationDisclosureStore();
    const mounted = render(reasoningTree(store, 'Inspecting the loaded history'));
    fireEvent.click(mounted.getByRole('button'));

    mounted.rerender(reasoningTree(store, 'Inspecting the loaded history', undefined, false));
    act(() => jest.advanceTimersByTime(1_100));

    expect(mounted.getByRole('button').getAttribute('aria-expanded')).toBe('true');
  } finally {
    jest.useRealTimers();
  }
});
