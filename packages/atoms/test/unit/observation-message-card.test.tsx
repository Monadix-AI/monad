import type { AgentObservationEvent } from '@monad/protocol';
import type { AgentObservationCard } from '../../src/agent-adapters/observation-cards.ts';
import type { ObservationTimelineRow } from '../../src/workplace-experiences/chat-room/components/observation/timeline.tsx';

import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { ObservationMessageCard } from '../../src/workplace-experiences/chat-room/components/observation/message-card.tsx';
import {
  ObservationTimelineRowView,
  observationTimelineEntries,
  observationTimelineRows
} from '../../src/workplace-experiences/chat-room/components/observation/timeline.tsx';

const raw = { id: 'raw-event' };

function publicRow(kind: AgentObservationEvent['kind'], text: string): ObservationTimelineRow {
  const event: AgentObservationEvent = {
    id: `event-${kind}`,
    kind,
    provenance: { contractEvents: [raw] },
    streaming: false,
    text
  };
  const card: AgentObservationCard = {
    id: `card-${kind}`,
    kind: kind === 'reasoning' ? 'reasoning' : kind === 'system' ? 'system' : 'message',
    payload: { event },
    provenance: event.provenance,
    streaming: false
  };
  return {
    id: card.id,
    entries: [
      {
        card,
        contractEvents: event.provenance.contractEvents,
        id: card.id,
        kind: 'public',
        timestamp: '12:34:56'
      }
    ]
  };
}

function correlatedEntry(
  kind: 'assistant-message' | 'reasoning',
  text: string,
  rawEventId: string,
  timestamp: string
): ObservationTimelineRow['entries'][number] {
  const contractEvent = {
    id: `contract-${kind}`,
    provenance: { rawEvents: [{ id: rawEventId, type: 'provider-message' }] }
  };
  const event: AgentObservationEvent = {
    id: `event-${kind}-${rawEventId}`,
    kind,
    provenance: { contractEvents: [contractEvent] },
    streaming: false,
    text
  };
  const card: AgentObservationCard = {
    id: `card-${kind}-${rawEventId}`,
    kind: kind === 'reasoning' ? 'reasoning' : 'message',
    payload: { event },
    provenance: event.provenance,
    streaming: false
  };
  return {
    card,
    contractEvents: event.provenance.contractEvents,
    id: card.id,
    kind: 'public',
    timestamp
  };
}

test('observation user messages keep their bubble while agent messages render as plain text without avatars', () => {
  const cases = [{ role: 'user' }, { role: 'agent' }] as const;
  const timestamp = new Date().toISOString();
  const timestampLabel = new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit' }).format(
    new Date(timestamp)
  );

  expect(
    cases.map(({ role }) => {
      const markup = renderToStaticMarkup(
        <ObservationMessageCard
          messageRole={role}
          streaming={false}
          text={`${role} text with \`inline code\``}
          timestamp={timestamp}
        />
      );
      return {
        avatar: markup.includes('width:34px;height:34px'),
        bubble: markup.includes('border-foreground bg-foreground text-background'),
        inlineCodeBorderless: markup.includes('border: 0;\n    border-radius: 7px;'),
        inlineCodeClonesDecoration: markup.includes('box-decoration-break: clone;'),
        inlineCodeKeepsWords: markup.includes('overflow-wrap: break-word;') && markup.includes('word-break: normal;'),
        plain: markup.includes('data-message-presentation="plain"'),
        providerLabel: markup.includes('codex'),
        smallText: markup.includes('text-sm leading-6'),
        text: markup.includes(`${role} text`),
        timestamp: markup.includes(timestampLabel),
        timestampAfterText: markup.indexOf(timestampLabel) > markup.indexOf(`${role} text`),
        timestampOnHover: markup.includes('group-hover/observation-message:opacity-100')
      };
    })
  ).toEqual([
    {
      avatar: false,
      bubble: true,
      inlineCodeBorderless: false,
      inlineCodeClonesDecoration: false,
      inlineCodeKeepsWords: false,
      plain: false,
      providerLabel: false,
      smallText: true,
      text: true,
      timestamp: false,
      timestampAfterText: false,
      timestampOnHover: false
    },
    {
      avatar: false,
      bubble: false,
      inlineCodeBorderless: true,
      inlineCodeClonesDecoration: true,
      inlineCodeKeepsWords: true,
      plain: true,
      providerLabel: false,
      smallText: true,
      text: true,
      timestamp: true,
      timestampAfterText: true,
      timestampOnHover: true
    }
  ]);
});

test('observation reasoning uses the shared collapsed reasoning component', () => {
  const markup = renderToStaticMarkup(
    <ObservationMessageCard
      messageRole="reasoning"
      streaming={false}
      text="Inspect the render path."
      timestamp="12:34:56"
    />
  );

  expect({
    collapseTrigger: markup.includes('aria-expanded'),
    content: markup.includes('Inspect the render path.'),
    label: markup.includes('Thought for a few seconds'),
    plain: markup.includes('data-message-presentation="plain"'),
    timestamp: markup.includes('12:34:56')
  }).toEqual({
    collapseTrigger: true,
    content: false,
    label: true,
    plain: true,
    timestamp: false
  });
});

test('empty observation reasoning shows its measured duration without an expandable body', () => {
  const markup = renderToStaticMarkup(
    <ObservationMessageCard
      messageRole="reasoning"
      reasoning={{ durationMs: 796, hasContent: false, streaming: false, text: 'Thinking…' }}
      streaming={false}
      text="Thinking…"
      timestamp="12:34:56"
    />
  );

  expect({
    body: markup.includes('Thinking…'),
    disabled: markup.includes('disabled=""'),
    duration: markup.includes('Thought for 1 second'),
    timestamp: markup.includes('12:34:56')
  }).toEqual({ body: false, disabled: true, duration: true, timestamp: false });
});

test('observation agent timestamps distinguish today, yesterday, and earlier dates', () => {
  const now = new Date();
  const timestamps = {
    earlier: new Date(now.getFullYear(), now.getMonth(), now.getDate() - 3, 12).toISOString(),
    today: now.toISOString(),
    yesterday: new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12).toISOString()
  };
  const markup = Object.fromEntries(
    Object.entries(timestamps).map(([bucket, timestamp]) => [
      bucket,
      renderToStaticMarkup(
        <ObservationMessageCard
          messageRole="agent"
          streaming={false}
          text={bucket}
          timestamp={timestamp}
        />
      )
    ])
  );
  const earlierDate = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short' }).format(
    new Date(timestamps.earlier)
  );

  expect({
    earlier: markup.earlier?.includes(earlierDate),
    today: markup.today?.includes('yesterday'),
    yesterday: markup.yesterday?.includes('yesterday')
  }).toEqual({ earlier: true, today: false, yesterday: true });
});

test('observation timeline routes only message-like roles through chat presentation', () => {
  const markup: Record<string, string> = Object.fromEntries(
    (
      [
        ['agent', publicRow('assistant-message', 'Agent output')],
        ['reasoning', publicRow('reasoning', 'Reasoning output')],
        ['user', publicRow('user-message', 'User input')]
      ] as const
    ).map(
      ([name, row]) =>
        [
          name,
          renderToStaticMarkup(
            <ObservationTimelineRowView
              provider="codex"
              row={row as ObservationTimelineRow}
            />
          )
        ] as const
    )
  );

  // behavior-ok: rendering all timeline roles keeps raw events exclusively in the separate Raw view.
  expect({
    agentUsesPlainText: markup.agent?.includes('data-message-presentation="plain"'),
    reasoningUsesCollapseTrigger: markup.reasoning?.includes('aria-expanded'),
    timelineHasInlineRawInspection: Object.values(markup).some((entry) => entry?.includes('Show raw JSONL')),
    userUsesMessageCard: markup.user?.includes('justify-end')
  }).toEqual({
    agentUsesPlainText: true,
    reasoningUsesCollapseTrigger: true,
    timelineHasInlineRawInspection: false,
    userUsesMessageCard: true
  });
});

test('observation timeline omits unrecognized system messages while keeping recognized system cards', () => {
  const cards: AgentObservationCard[] = [
    {
      id: 'unrecognized-system',
      kind: 'system',
      payload: {
        event: {
          id: 'unrecognized-system',
          kind: 'system',
          provenance: { contractEvents: [{ type: 'system', subtype: 'task_progress' }] },
          streaming: false,
          text: 'task_progress'
        }
      },
      provenance: { contractEvents: [{ type: 'system', subtype: 'task_progress' }] },
      streaming: false
    },
    {
      id: 'unrecognized-event',
      kind: 'unknown',
      payload: {
        event: {
          id: 'unrecognized-event',
          kind: 'unknown',
          provenance: { contractEvents: [{ type: 'future_provider_event' }] },
          streaming: false,
          text: 'future_provider_event'
        }
      },
      provenance: { contractEvents: [{ type: 'future_provider_event' }] },
      streaming: false
    },
    {
      id: 'recognized-compaction',
      kind: 'context-compaction',
      payload: {
        event: {
          id: 'recognized-compaction',
          kind: 'context-compaction',
          provenance: { contractEvents: [{ type: 'context_compaction' }] },
          streaming: false,
          text: 'Context compacted'
        }
      },
      provenance: { contractEvents: [{ type: 'context_compaction' }] },
      streaming: false
    },
    {
      id: 'recognized-diagnostic',
      kind: 'diagnostic',
      payload: {
        event: {
          diagnostic: { message: 'Connection failed', severity: 'error' },
          id: 'recognized-diagnostic',
          kind: 'system',
          provenance: { contractEvents: [{ type: 'connection_error' }] },
          streaming: false,
          text: 'Connection failed'
        }
      },
      provenance: { contractEvents: [{ type: 'connection_error' }] },
      streaming: false
    }
  ];

  expect(
    observationTimelineEntries(cards, 'codex').flatMap((entry) => (entry.kind === 'public' ? [entry.card.kind] : []))
  ).toEqual(['context-compaction', 'diagnostic']);
});

test('observation timeline keeps timestamps only for assistant messages across providers', () => {
  const kinds = ['assistant-message', 'user-message', 'reasoning', 'context-compaction'] as const;
  const cards: AgentObservationCard[] = kinds.map((kind) => {
    const event: AgentObservationEvent = {
      at: '2026-08-09T00:38:09.125Z',
      id: `timestamp-${kind}`,
      kind,
      provenance: { contractEvents: [{ provider: 'any' }] },
      streaming: false,
      text: kind
    };
    return {
      id: event.id,
      kind: kind === 'reasoning' ? 'reasoning' : kind === 'context-compaction' ? 'context-compaction' : 'message',
      payload: { event },
      provenance: event.provenance,
      streaming: false
    };
  });

  expect(observationTimelineEntries(cards, 'any').map((entry) => entry.timestamp !== undefined)).toEqual([
    true,
    false,
    false,
    false
  ]);
});

test('observation timeline groups only reasoning and responses from the same provider event', () => {
  const reasoning = correlatedEntry(
    'reasoning',
    'Inspect the render path.',
    'provider-event-1',
    '2026-08-09T12:34:55.000Z'
  );
  const response = correlatedEntry(
    'assistant-message',
    'Rendered response.',
    'provider-event-1',
    '2026-08-09T12:34:56.000Z'
  );
  const unrelatedResponse = correlatedEntry(
    'assistant-message',
    'Response after a tool boundary.',
    'provider-event-2',
    '2026-08-09T12:35:00.000Z'
  );
  const grouped = observationTimelineRows([reasoning, response]);
  const separated = observationTimelineRows([reasoning, unrelatedResponse]);

  expect({
    groupedEntryCounts: grouped.map((row) => row.entries.length),
    groupedRowCount: grouped.length,
    separatedEntryCounts: separated.map((row) => row.entries.length),
    separatedRowCount: separated.length
  }).toEqual({
    groupedEntryCounts: [2],
    groupedRowCount: 1,
    separatedEntryCounts: [1, 1],
    separatedRowCount: 2
  });

  const markup = renderToStaticMarkup(
    <ObservationTimelineRowView
      provider="codex"
      row={grouped[0] as ObservationTimelineRow}
    />
  );
  expect({
    agentPlainTextCount: markup.split('data-message-presentation="plain"').length - 1,
    collapseTrigger: markup.includes('aria-expanded'),
    reasoningContent: markup.includes('Inspect the render path.'),
    response: markup.includes('Rendered response.'),
    responseTimestamp: markup.includes('<time')
  }).toEqual({
    agentPlainTextCount: 1,
    collapseTrigger: true,
    reasoningContent: false,
    response: true,
    responseTimestamp: true
  });
});
