import type { AgentObservationEvent } from '@monad/protocol';
import type { AgentObservationCard } from '../../src/agent-adapters/observation-cards.ts';
import type { ObservationTimelineRow } from '../../src/workplace-experiences/chat-room/components/observation/timeline.tsx';

import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { FilePreviewContext } from '../../src/workplace-experiences/chat-room/components/file-preview-context.tsx';
import {
  ObservationMessageCard,
  observationReasoningContent,
  observationReasoningHasContent,
  observationReasoningTitle
} from '../../src/workplace-experiences/chat-room/components/observation/message-card.tsx';
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

test('observation user and agent messages render their content and timestamp without avatars', () => {
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
        avatar: markup.includes('<img'),
        plain: markup.includes('data-message-presentation="plain"'),
        providerLabel: markup.includes('codex'),
        text: markup.includes(`${role} text`),
        timestamp: markup.includes(timestampLabel),
        timestampAfterText: markup.indexOf(timestampLabel) > markup.indexOf(`${role} text`)
      };
    })
  ).toEqual([
    {
      avatar: false,
      plain: false,
      providerLabel: false,
      text: true,
      timestamp: true,
      timestampAfterText: true
    },
    {
      avatar: false,
      plain: true,
      providerLabel: false,
      text: true,
      timestamp: true,
      timestampAfterText: true
    }
  ]);
});

test('observation message absolute paths resolve to local preview actions without HTTP navigation', () => {
  const attachment = {
    bytes: 2048,
    createdAt: '2026-08-11T00:00:00.000Z',
    id: 'att_observation_image',
    mime: 'image/png',
    name: 'result.png',
    path: '/workspace/result.png'
  } as const;
  const markup = renderToStaticMarkup(
    <FilePreviewContext.Provider value={{ attachments: [attachment], onOpenAttachment: () => {} }}>
      <ObservationMessageCard
        messageRole="agent"
        streaming={false}
        text="Generated [result](/workspace/result.png)."
      />
    </FilePreviewContext.Provider>
  );

  expect({
    localAction: /<button[^>]+data-inline-link="file"[^>]*>/.test(markup),
    noHttpPath: !markup.includes('href="/workspace/result.png"')
  }).toEqual({ localAction: true, noHttpPath: true });
});

test('observation reasoning uses the shared collapsed reasoning component', () => {
  const timestamp = new Date().toISOString();
  const timestampLabel = new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit' }).format(
    new Date(timestamp)
  );
  const markup = renderToStaticMarkup(
    <ObservationMessageCard
      messageRole="reasoning"
      streaming={false}
      text="Inspect the render path."
      timestamp={timestamp}
    />
  );

  expect({
    collapseTrigger: markup.includes('aria-expanded'),
    content: markup.includes('Inspect the render path.'),
    label: markup.includes('Thought for a few seconds'),
    plain: markup.includes('data-message-presentation="plain"'),
    timestamp: markup.includes(timestampLabel)
  }).toEqual({
    collapseTrigger: true,
    content: false,
    label: true,
    plain: true,
    timestamp: true
  });
});

test('streaming observation reasoning uses the working orb', () => {
  const markup = renderToStaticMarkup(
    <ObservationMessageCard
      messageRole="reasoning"
      reasoning={{ streaming: true, text: 'Inspecting the live event.' }}
      streaming
      text="Inspecting the live event."
    />
  );

  expect({
    label: /<canvas[^>]+aria-label="([^"]+)"/.exec(markup)?.[1],
    state: /<canvas[^>]+data-orb-state="([^"]+)"/.exec(markup)?.[1]
  }).toEqual({ label: 'Working…', state: 'working' });
});

test('streaming observation reasoning prefixes the current Codex summary with the thinking state', () => {
  const markup = renderToStaticMarkup(
    <ObservationMessageCard
      messageRole="reasoning"
      reasoning={{
        hasContent: false,
        streaming: true,
        summary: '**Planning image generation**',
        text: 'Thinking…'
      }}
      streaming
      text="Thinking…"
    />
  );

  expect({
    disabled: markup.includes('disabled=""'),
    oneSummary: markup.match(/Planning image generation/g)?.length,
    title: markup.includes('Thinking… 0s · Planning image generation')
  }).toEqual({ disabled: true, oneSummary: 1, title: true });
});

test('completed observation reasoning puts its only summary in the title without a disclosure', () => {
  const markup = renderToStaticMarkup(
    <ObservationMessageCard
      messageRole="reasoning"
      reasoning={{
        durationMs: 2400,
        hasContent: false,
        streaming: false,
        summary: 'Checking the event projection with a title that is too long to fit in the observation panel',
        text: 'Thinking…'
      }}
      streaming={false}
      text="Thinking…"
    />
  );

  expect({
    body: markup.includes('Thinking…'),
    disabled: markup.includes('disabled=""'),
    duration: markup.includes('Thought for 3 seconds'),
    summary: markup.includes('Checking the event projection')
  }).toEqual({ body: false, disabled: true, duration: true, summary: true });
});

test('completed observation reasoning does not disclose content that repeats its only summary', () => {
  const summary = '**Planning timeline card rendering test**';
  const text = 'Planning timeline card rendering test';
  const markup = renderToStaticMarkup(
    <ObservationMessageCard
      messageRole="reasoning"
      reasoning={{ durationMs: 4000, hasContent: true, streaming: false, summary, text }}
      streaming={false}
      text={text}
    />
  );

  expect({
    chevron: markup.includes('data-slot="disclosure-chevron"'),
    disabled: markup.includes('disabled=""'),
    renderedSummaries: markup.match(/Planning timeline card rendering test/g)?.length,
    resolvedContent: observationReasoningHasContent(summary, text, true)
  }).toEqual({ chevron: false, disabled: true, renderedSummaries: 1, resolvedContent: false });
});

test('multi-part reasoning keeps summaries out of the title and exposes the complete expandable content', () => {
  const summary = '**Planning shared memory read**\n\n**Executing the project lookup**';
  const markup = renderToStaticMarkup(
    <ObservationMessageCard
      messageRole="reasoning"
      reasoning={{ durationMs: 2400, hasContent: false, streaming: false, summary, text: 'Thinking…' }}
      streaming={false}
      text="Thinking…"
    />
  );

  expect({
    content: observationReasoningContent(summary, 'Thinking…'),
    disabled: markup.includes('disabled=""'),
    title: observationReasoningTitle(summary),
    visibleFirstPart: markup.includes('Planning shared memory read'),
    visibleSecondPart: markup.includes('Executing the project lookup')
  }).toEqual({
    content: summary,
    disabled: false,
    title: undefined,
    visibleFirstPart: false,
    visibleSecondPart: false
  });
});

test('completed Claude reasoning shows measured duration and estimated tokens', () => {
  const markup = renderToStaticMarkup(
    <ObservationMessageCard
      messageRole="reasoning"
      reasoning={{
        durationMs: 2400,
        hasContent: false,
        streaming: false,
        summary: 'Thinking… 151 tokens',
        text: 'Thinking…'
      }}
      streaming={false}
      text="Thinking…"
    />
  );

  expect({ disabled: markup.includes('disabled=""'), text: visibleText(markup) }).toEqual({
    disabled: true,
    text: 'Thought for 3 seconds · 151 tokens'
  });
});

test('completed Claude reasoning with content remains expandable when its summary reports tokens', () => {
  const markup = renderToStaticMarkup(
    <ObservationMessageCard
      messageRole="reasoning"
      reasoning={{
        durationMs: 2400,
        hasContent: true,
        streaming: false,
        summary: 'Thinking… 151 tokens',
        text: 'Inspect the live Claude event projection.'
      }}
      streaming={false}
      text="Inspect the live Claude event projection."
    />
  );

  expect({
    collapsedContent: markup.includes('Inspect the live Claude event projection.'),
    disclosure: markup.includes('aria-expanded="false"'),
    disabled: markup.includes('disabled=""'),
    title: visibleText(markup)
  }).toEqual({
    collapsedContent: false,
    disclosure: true,
    disabled: false,
    title: 'Thought for 3 seconds · 151 tokens'
  });
});

test('observation reasoning recovers a Codex summary from raw provenance for existing events', () => {
  const contractEvent = {
    provenance: {
      rawEvents: [
        {
          method: 'item/completed',
          params: {
            item: {
              type: 'reasoning',
              id: 'item-reasoning-summary',
              summary: ['**Planning shared memory read**', '**Executing the project lookup**'],
              content: []
            },
            threadId: 'thread-reasoning-summary',
            turnId: 'turn-reasoning-summary'
          }
        }
      ]
    }
  };
  const event: AgentObservationEvent = {
    hasContent: false,
    id: 'event-reasoning-summary',
    kind: 'reasoning',
    provenance: { contractEvents: [contractEvent] },
    streaming: false,
    text: 'Thinking…'
  };
  const card: AgentObservationCard = {
    id: event.id,
    kind: 'reasoning',
    payload: { event },
    provenance: event.provenance,
    streaming: false
  };
  const markup = renderToStaticMarkup(
    <ObservationTimelineRowView
      provider="codex"
      row={{
        id: card.id,
        entries: [
          {
            card,
            contractEvents: event.provenance.contractEvents,
            id: card.id,
            kind: 'public'
          }
        ]
      }}
    />
  );

  expect({
    disabled: markup.includes('disabled=""'),
    fallback: markup.includes('Thought for'),
    markdownMarkers: markup.includes('**'),
    summaryInTitle: markup.includes('Planning shared memory read'),
    visibleSecondPart: markup.includes('Executing the project lookup')
  }).toEqual({
    disabled: false,
    fallback: true,
    markdownMarkers: false,
    summaryInTitle: false,
    visibleSecondPart: false
  });
});

test('empty observation reasoning shows its measured duration without an expandable body', () => {
  const timestamp = new Date().toISOString();
  const timestampLabel = new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit' }).format(
    new Date(timestamp)
  );
  const markup = renderToStaticMarkup(
    <ObservationMessageCard
      messageRole="reasoning"
      reasoning={{ durationMs: 796, hasContent: false, streaming: false, text: 'Thinking…' }}
      streaming={false}
      text="Thinking…"
      timestamp={timestamp}
    />
  );

  expect({
    body: markup.includes('Thinking…'),
    disabled: markup.includes('disabled=""'),
    duration: markup.includes('Thought for 1 second'),
    timestamp: markup.includes(timestampLabel)
  }).toEqual({ body: false, disabled: true, duration: true, timestamp: true });
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

function visibleText(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

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

test('observation timeline keeps timestamps only for user and assistant messages', () => {
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
    true,
    false,
    false
  ]);
});

test('observation assistant messages fall back to the card timestamp', () => {
  const card: AgentObservationCard = {
    at: '2026-08-09T00:38:09.125Z',
    id: 'timestamp-card-fallback',
    kind: 'message',
    payload: {
      event: {
        id: 'timestamp-card-fallback',
        kind: 'assistant-message',
        provenance: { contractEvents: [{ provider: 'any' }] },
        streaming: false,
        text: 'Completed response'
      }
    },
    provenance: { contractEvents: [{ provider: 'any' }] },
    streaming: false
  };

  expect(observationTimelineEntries([card], 'any')[0]?.timestamp).toBe('2026-08-09T00:38:09.125Z');
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
