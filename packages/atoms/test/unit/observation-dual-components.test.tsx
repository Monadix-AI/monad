// Observation Task 5: the raw-plane list and the raw ⇆ convenience mode toggle render as static markup
// (no DOM runtime needed), matching the file-preview panel test approach.

import type { RawFrameRow } from '../../src/workspace-experiences/chat-room/components/observation/raw-view.ts';
import type { ObservationPanelHooks } from '../../src/workspace-experiences/chat-room/components/observation/use-observation-panel.ts';

import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { DualObservationPanel } from '../../src/workspace-experiences/chat-room/components/observation/dual-observation-panel.tsx';
import {
  ObservationModeToggle,
  RawDisplayModeToggle
} from '../../src/workspace-experiences/chat-room/components/observation/observation-mode-toggle.tsx';
import { MeshAgentObservationPanel } from '../../src/workspace-experiences/chat-room/components/observation/panel.tsx';
import {
  RawObservationCard,
  RawObservationList,
  rawVirtualListControlProps
} from '../../src/workspace-experiences/chat-room/components/observation/raw-observation-list.tsx';
import { rawDisplayEntries } from '../../src/workspace-experiences/chat-room/components/observation/raw-view.ts';

// RawObservationList itself renders through @monad/ui VirtualList, which only paints rows once
// mounted client-side (its rows are gated behind a post-layout-effect `scrollerReady` flag) — an
// SSR render of the list never shows row content. RawObservationCard is the extracted, effect-free
// per-row presentation, so row title/body/lines/parsed rendering stays covered by SSR markup here;
// RawObservationList's own SSR coverage below is limited to what SSR actually renders: the empty
// state and the header banner (VirtualList's `header` prop renders unconditionally, unlike its rows).
function rawCardText(preview: string, mode: 'lines' | 'parsed' = 'lines'): string {
  return rawDisplayEntries(preview, mode).join('\n');
}

const PANEL_HOOKS: ObservationPanelHooks = {
  useConnection: () => ({ refetch: () => {} }),
  useRawStream: () => ({}),
  useConvenienceStream: () => ({}),
  useRawEvents: () => [() => ({ unwrap: async () => ({ records: [], coverage: 'exact' }) })],
  useConvenienceEvents: () => [() => ({ unwrap: async () => ({ frames: [] }) })]
};

test('raw card renders its stream label, cursor row-marker, and verbatim preview', () => {
  const rows: RawFrameRow[] = [
    { identity: 'c1', cursor: 'c1', stream: 'stdout', preview: 'hello world' },
    { identity: 'c2', cursor: 'c2', stream: 'unknown', preview: '{"k":"v"}' }
  ];
  const markup = rows
    .map((row) => renderToStaticMarkup(createElement(RawObservationCard, { row, text: rawCardText(row.preview) })))
    .join('');
  expect(markup).toContain('data-observation-raw-row="c1"');
  expect(markup).toContain('data-observation-raw-row="c2"');
  expect(markup).toContain('hello world');
  expect(markup).toContain('{&quot;k&quot;:&quot;v&quot;}');
  expect(markup).toContain('raw');
});

test('raw card renders its preview in a directly visible preformatted body keyed by provider identity', () => {
  const row: RawFrameRow = {
    identity: 'turn-1:3',
    cursor: '17',
    stream: 'unknown',
    preview: '{"type":"response_item"}'
  };
  const markup = renderToStaticMarkup(createElement(RawObservationCard, { row, text: rawCardText(row.preview) }));
  const preview = /<pre[^>]*data-observation-raw-preview="turn-1:3"[^>]*>(.*?)<\/pre>/.exec(markup)?.[1];

  expect(preview).toBe('{&quot;type&quot;:&quot;response_item&quot;}');
  expect(markup).toContain('>turn-1:3</span>');
  expect(markup).toContain('min-height:40px');
  expect(markup).toContain('background:var(--background)');
});

test('raw card exposes a per-frame copy action without changing the visible raw preview', () => {
  const row: RawFrameRow = {
    identity: 'copy-row',
    cursor: 'provider:copy-row',
    stream: 'stdout',
    preview: '{"copy":true}'
  };
  const markup = renderToStaticMarkup(createElement(RawObservationCard, { row, text: rawCardText(row.preview) }));

  expect({
    copyAction: /<button[^>]*aria-label="Copy raw event"[^>]*data-observation-raw-copy="idle"/.test(markup),
    preview: /<pre[^>]*data-observation-raw-preview="copy-row"[^>]*>(.*?)<\/pre>/.exec(markup)?.[1]
  }).toEqual({ copyAction: true, preview: '{&quot;copy&quot;:true}' });
});

test('raw card lines mode keeps long records on one line with horizontal scrolling', () => {
  const row: RawFrameRow = {
    identity: 'line-scroll',
    cursor: 'provider:line-scroll',
    stream: 'unknown',
    preview: '{"long":"value"}'
  };
  const markup = renderToStaticMarkup(
    createElement(RawObservationCard, { displayMode: 'lines', row, text: rawCardText(row.preview) })
  );

  expect({
    horizontalScroll: markup.includes('overflow-x:auto'),
    preservesLines: markup.includes('white-space:pre;'),
    wrapsWords: markup.includes('word-break:break-word')
  }).toEqual({ horizontalScroll: true, preservesLines: true, wrapsWords: false });
});

test('raw card parsed mode renders formatted JSON through the syntax highlighter', () => {
  const row: RawFrameRow = {
    identity: 'parsed-json',
    cursor: 'provider:parsed-json',
    stream: 'unknown',
    preview: '{"key":"value"}'
  };
  const markup = renderToStaticMarkup(
    createElement(RawObservationCard, {
      displayMode: 'parsed',
      row,
      text: rawCardText(row.preview, 'parsed')
    })
  );

  expect({
    formatted: markup.includes('  &quot;key&quot;: &quot;value&quot;'),
    highlightedAsJson: markup.includes('data-language="json"')
  }).toEqual({ formatted: true, highlightedAsJson: true });
});

test('raw list header shows the earlier-events loading state while a page is in flight', () => {
  const markup = renderToStaticMarkup(
    createElement(RawObservationList, {
      canLoadOlderEvents: true,
      loadingOlderEvents: true,
      rows: [{ identity: 'raw-1', cursor: 'provider:raw-1', stream: 'unknown', preview: '{"raw":true}' }]
    })
  );

  expect({
    loadingState: markup.includes('data-events-state="loading"'),
    loadingText: markup.includes('Loading earlier events…')
  }).toEqual({ loadingState: true, loadingText: true });
});

test('raw list header shows an entry point to load more, or the start-of-events marker, when idle', () => {
  const rows: RawFrameRow[] = [{ identity: 'raw-1', cursor: 'provider:raw-1', stream: 'unknown', preview: 'x' }];
  const moreMarkup = renderToStaticMarkup(createElement(RawObservationList, { canLoadOlderEvents: true, rows }));
  const startMarkup = renderToStaticMarkup(createElement(RawObservationList, { canLoadOlderEvents: false, rows }));

  expect({
    more: {
      state: moreMarkup.includes('data-events-state="more"'),
      text: moreMarkup.includes('Scroll up for earlier events')
    },
    start: { state: startMarkup.includes('data-events-state="start"'), text: startMarkup.includes('Start of events') }
  }).toEqual({ more: { state: true, text: true }, start: { state: true, text: true } });
});

test("raw list wires VirtualList to stay end-anchored so prepend/scrollToTop share the chat transcript's anchoring, and gates onStartReached on canLoadOlderEvents/loadingOlderEvents", () => {
  const card = { row: { identity: 'r1', cursor: 'r1', stream: 'unknown' as const, preview: 'x' }, text: 'x' };
  const cards = [card];

  const idle = rawVirtualListControlProps({ cards, canLoadOlderEvents: true, loadingOlderEvents: false });
  expect(idle.stickToBottom).toBe(true);
  expect(idle.items).toBe(cards);
  expect(idle.getKey(card)).toBe('r1');

  let loadCalls = 0;
  const gated = rawVirtualListControlProps({
    cards,
    canLoadOlderEvents: true,
    loadingOlderEvents: false,
    onLoadOlderEvents: () => {
      loadCalls += 1;
    }
  });
  gated.onStartReached();
  expect(loadCalls).toBe(1);

  const whileLoading = rawVirtualListControlProps({
    cards,
    canLoadOlderEvents: true,
    loadingOlderEvents: true,
    onLoadOlderEvents: () => {
      loadCalls += 1;
    }
  });
  expect(whileLoading.onStartReached()).toBe(false);
  expect(loadCalls).toBe(1);

  const noMoreEvents = rawVirtualListControlProps({
    cards,
    canLoadOlderEvents: false,
    loadingOlderEvents: false,
    onLoadOlderEvents: () => {
      loadCalls += 1;
    }
  });
  expect(noMoreEvents.onStartReached()).toBe(false);
  expect(loadCalls).toBe(1);
});

test('raw list shows an empty-state marker when there are no frames', () => {
  const markup = renderToStaticMarkup(createElement(RawObservationList, { rows: [] }));
  expect(markup).toContain('data-observation-raw="empty"');
  expect(markup).toContain('No raw frames yet');
});

test('raw card parsed view pretty-prints JSON without changing non-JSON text', () => {
  const rows: RawFrameRow[] = [
    { identity: 'c1', cursor: 'c1', stream: 'stdout', preview: '{"k":"v"}' },
    { identity: 'c2', cursor: 'c2', stream: 'stdout', preview: 'plain text' }
  ];
  const markup = rows
    .map((row) =>
      renderToStaticMarkup(
        createElement(RawObservationCard, {
          displayMode: 'parsed',
          row,
          text: rawCardText(row.preview, 'parsed')
        })
      )
    )
    .join('');
  expect(markup).toContain('  &quot;k&quot;: &quot;v&quot;');
  expect(markup).toContain('plain text');
});

test('raw card lines and parsed modes reuse one bounded visible card per frame with its provider identity in the header', () => {
  const row: RawFrameRow = {
    identity: 'provider-event-1',
    cursor: 'provider:page-4:item-1',
    stream: 'stdout',
    preview: '{"a":1}\n{"b":2}\n'
  };
  const linesMarkup = renderToStaticMarkup(
    createElement(RawObservationCard, { displayMode: 'lines', row, text: rawCardText(row.preview, 'lines') })
  );
  const parsedMarkup = renderToStaticMarkup(
    createElement(RawObservationCard, { displayMode: 'parsed', row, text: rawCardText(row.preview, 'parsed') })
  );

  expect(linesMarkup.match(/data-observation-raw-row=/g)?.length).toBe(1);
  expect(parsedMarkup.match(/data-observation-raw-row=/g)?.length).toBe(1);
  expect(linesMarkup).toContain('data-raw-card-id="provider-event-1"');
  expect(parsedMarkup).toContain('data-raw-card-id="provider-event-1"');
  expect(linesMarkup).toContain('provider:page-4:item-1');
  expect(parsedMarkup).toContain('provider:page-4:item-1');
  expect(linesMarkup).toContain('>provider-event-1</span>');
  expect(parsedMarkup).toContain('>provider-event-1</span>');
  expect(/data-observation-raw-preview="provider-event-1"[^>]*>([\s\S]*?)<\/pre>/.exec(linesMarkup)?.[1]).toBe(
    '{&quot;a&quot;:1}\n{&quot;b&quot;:2}'
  );
  expect({
    firstRecord: parsedMarkup.includes('  &quot;a&quot;: 1'),
    highlightedAsJson: parsedMarkup.includes('data-language="json"'),
    secondRecord: parsedMarkup.includes('  &quot;b&quot;: 2')
  }).toEqual({ firstRecord: true, highlightedAsJson: true, secondRecord: true });
  expect(linesMarkup).toContain('max-height:256px');
  expect(parsedMarkup).toContain('max-height:256px');
});

test('initial observation loading renders a skeleton without an earlier-events loader', () => {
  const markup = renderToStaticMarkup(
    createElement(MeshAgentObservationPanel, {
      agentName: 'Claude',
      canLoadOlderEvents: true,
      eventsActive: true,
      loadingOlderEvents: false,
      observationLoading: true,
      stream: {
        id: 'mesh_100000000000',
        agentName: 'Claude',
        provider: 'claude',
        tag: 'Agent',
        status: 'running',
        output: '',
        items: []
      }
    })
  );

  expect(markup).toContain('data-observation-state="loading"');
  expect(markup).toContain('data-observation-skeleton="true"');
  expect(markup).not.toContain('data-events-state="loading"');
  expect(markup).not.toContain('>Loading events');
});

test('mode toggle marks the active plane selected and the other unselected', () => {
  const markup = renderToStaticMarkup(createElement(ObservationModeToggle, { mode: 'raw', onSelect: () => {} }));
  const activeRaw = /<button[^>]*aria-selected="true"[^>]*role="tab"[^>]*>Raw<\/button>/;
  const inactiveActivity = /<button[^>]*aria-selected="false"[^>]*role="tab"[^>]*>Activity<\/button>/;
  expect(activeRaw.test(markup)).toBe(true);
  expect(inactiveActivity.test(markup)).toBe(true);
});

test('raw display toggle exposes Lines and Parsed as presentation modes', () => {
  const markup = renderToStaticMarkup(createElement(RawDisplayModeToggle, { mode: 'parsed', onSelect: () => {} }));
  expect(markup).toContain('aria-label="Raw display"');
  expect(markup).toContain('>Lines</button>');
  expect(markup).toContain('aria-selected="true"');
  expect(markup).toContain('>Parsed</button>');
});

test('dual panel keeps the agent avatar and plane toggle in the same header row', () => {
  const markup = renderToStaticMarkup(
    createElement(DualObservationPanel, {
      agent: {
        id: 'agent_ada',
        av: 'AA',
        avatarUrl: 'https://example.test/agent-ada.png',
        kind: 'agent',
        name: 'Agent Ada',
        presence: 'working',
        tag: 'Agent'
      },
      agentName: 'Agent Ada',
      meshSessionId: 'mesh_100000000000',
      hooks: PANEL_HOOKS,
      provider: 'codex',
      transcriptTargetId: 'ses_100000000000'
    })
  );

  const header = markup.slice(markup.indexOf('<header'), markup.indexOf('</header>'));
  expect(header).toContain('<img aria-hidden="true" alt="" src="https://example.test/agent-ada.png"');
  expect(header).toContain('aria-label="Observation view"');
  expect(header).toContain('>Activity</button>');
  expect(header).toContain('>Raw</button>');
  expect(header.indexOf('Collapse all activity')).toBeLessThan(header.indexOf('Observation view'));
});
