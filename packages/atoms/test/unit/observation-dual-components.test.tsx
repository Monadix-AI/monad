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
import { RawObservationList } from '../../src/workspace-experiences/chat-room/components/observation/raw-observation-list.tsx';

const PANEL_HOOKS: ObservationPanelHooks = {
  useConnection: () => ({ refetch: () => {} }),
  useRawStream: () => ({}),
  useConvenienceStream: () => ({}),
  useRawEvents: () => [() => ({ unwrap: async () => ({ records: [], coverage: 'exact' }) })],
  useConvenienceEvents: () => [() => ({ unwrap: async () => ({ frames: [] }) })]
};

test('raw list renders one row per frame with its stream label, cursor, and verbatim preview', () => {
  const rows: RawFrameRow[] = [
    { identity: 'c1', cursor: 'c1', stream: 'stdout', preview: 'hello world' },
    { identity: 'c2', cursor: 'c2', stream: 'unknown', preview: '{"k":"v"}' }
  ];
  const markup = renderToStaticMarkup(createElement(RawObservationList, { rows }));
  expect(markup).toContain('data-observation-raw-row="c1"');
  expect(markup).toContain('data-observation-raw-row="c2"');
  expect(markup).toContain('hello world');
  expect(markup).toContain('{&quot;k&quot;:&quot;v&quot;}');
  expect(markup).toContain('raw');
});

test('raw list shows an empty-state marker when there are no frames', () => {
  const markup = renderToStaticMarkup(createElement(RawObservationList, { rows: [] }));
  expect(markup).toContain('data-observation-raw="empty"');
  expect(markup).toContain('No raw frames yet');
});

test('raw parsed view pretty-prints JSON without changing non-JSON text', () => {
  const rows: RawFrameRow[] = [
    { identity: 'c1', cursor: 'c1', stream: 'app-server', preview: '{"k":"v"}' },
    { identity: 'c2', cursor: 'c2', stream: 'stdout', preview: 'plain text' }
  ];
  const markup = renderToStaticMarkup(createElement(RawObservationList, { rows, displayMode: 'parsed' }));
  expect(markup).toContain('  &quot;k&quot;: &quot;v&quot;');
  expect(markup).toContain('plain text');
});

test('raw lines and parsed modes reuse one bounded card per frame with its cursor in the header', () => {
  const rows: RawFrameRow[] = [
    { identity: 'provider-event-1', cursor: 'provider:page-4:item-1', stream: 'stdout', preview: '{"a":1}\n{"b":2}\n' }
  ];
  const linesMarkup = renderToStaticMarkup(createElement(RawObservationList, { rows, displayMode: 'lines' }));
  const parsedMarkup = renderToStaticMarkup(createElement(RawObservationList, { rows, displayMode: 'parsed' }));

  expect(linesMarkup.match(/data-observation-raw-row=/g)?.length).toBe(1);
  expect(parsedMarkup.match(/data-observation-raw-row=/g)?.length).toBe(1);
  expect(linesMarkup).toContain('data-raw-card-id="provider-event-1"');
  expect(parsedMarkup).toContain('data-raw-card-id="provider-event-1"');
  expect(linesMarkup).toContain('provider:page-4:item-1');
  expect(parsedMarkup).toContain('provider:page-4:item-1');
  expect(linesMarkup).toContain('data-language="json"');
  expect(parsedMarkup).toContain('data-language="json"');
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
