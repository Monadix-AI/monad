import type { AgentObservationEvent } from '@monad/protocol';

import { expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { agentObservationCards } from '../../src/agent-adapters/observation-cards.ts';
import {
  ObservationTimelineRowView,
  observationTimelineEntries,
  observationTimelineRows
} from '../../src/workplace-experiences/chat-room/components/observation/timeline.tsx';

test('context compaction renders without a summary control', () => {
  const event: AgentObservationEvent = {
    id: 'compact-1',
    kind: 'context-compaction',
    streaming: false,
    text: 'Context compacted',
    provenance: {
      contractEvents: [{ type: 'contextCompaction', id: 'item-785' }]
    }
  };
  const rows = observationTimelineRows(observationTimelineEntries(agentObservationCards([event], 'codex'), 'codex'));
  const row = rows[0];
  if (!row) throw new Error('context compaction projection did not produce a timeline row');
  const markup = renderToStaticMarkup(
    React.createElement(ObservationTimelineRowView, {
      provider: 'codex',
      row
    })
  );

  expect({
    marker: markup.includes('data-observation-context-compaction'),
    hoverControl: markup.includes('<button')
  }).toEqual({
    marker: true,
    hoverControl: false
  });
});
