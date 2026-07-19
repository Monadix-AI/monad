// Observation Task 5: the raw-plane list and the raw ⇆ convenience mode toggle render as static markup
// (no DOM runtime needed), matching the file-preview panel test approach.

import type { RawFrameRow } from '../../src/workspace-experiences/chat-room/components/observation/raw-view.ts';
import type { ObservationPanelHooks } from '../../src/workspace-experiences/chat-room/components/observation/use-observation-panel.ts';

import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { DualObservationPanel } from '../../src/workspace-experiences/chat-room/components/observation/dual-observation-panel.tsx';
import { ObservationModeToggle } from '../../src/workspace-experiences/chat-room/components/observation/observation-mode-toggle.tsx';
import { RawObservationList } from '../../src/workspace-experiences/chat-room/components/observation/raw-observation-list.tsx';

const PANEL_HOOKS: ObservationPanelHooks = {
  useConnection: () => ({ refetch: () => {} }),
  useRawStream: () => ({}),
  useConvenienceStream: () => ({}),
  useRawHistory: () => [() => ({ unwrap: async () => ({ records: [], coverage: 'exact' }) })],
  useConvenienceHistory: () => [() => ({ unwrap: async () => [] })]
};

test('raw list renders one row per frame with its stream label, cursor, and verbatim preview', () => {
  const rows: RawFrameRow[] = [
    { cursor: 'c1', stream: 'stdout', preview: 'hello world' },
    { cursor: 'c2', stream: 'unknown', preview: '{"k":"v"}' }
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

test('mode toggle marks the active plane selected and the other unselected', () => {
  const markup = renderToStaticMarkup(createElement(ObservationModeToggle, { mode: 'raw', onSelect: () => {} }));
  const activeRaw = /<button[^>]*aria-selected="true"[^>]*role="tab"[^>]*>Raw<\/button>/;
  const inactiveActivity = /<button[^>]*aria-selected="false"[^>]*role="tab"[^>]*>Activity<\/button>/;
  expect(activeRaw.test(markup)).toBe(true);
  expect(inactiveActivity.test(markup)).toBe(true);
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
      externalAgentSessionId: 'exa_100000000000',
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
});
