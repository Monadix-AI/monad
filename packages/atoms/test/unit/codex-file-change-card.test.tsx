import type { AgentObservationEvent } from '@monad/protocol';

import { expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { builtinAgentAdapters } from '../../src/agent-adapters/index.ts';
import { agentObservationCards } from '../../src/agent-adapters/observation-cards.ts';
import {
  CodexFileChangeCard,
  codexFileChangeView
} from '../../src/workplace-experiences/chat-room/components/observation/codex-file-change-card.tsx';
import {
  ObservationTimelineRowView,
  observationTimelineEntries,
  observationTimelineRows
} from '../../src/workplace-experiences/chat-room/components/observation/timeline.tsx';
import { meshAgentNeutralStreamItems } from '../../src/workplace-experiences/experience/mesh-agent-observation/mesh-agent-observation.ts';

const changes = [
  {
    path: 'docs/plan.md',
    kind: { type: 'update', move_path: null },
    diff: '@@ -1,2 +1,3 @@\n-old\n+new\n+verified'
  },
  {
    path: 'packages/atoms/src/adapter.ts',
    kind: { type: 'update', move_path: null },
    diff: '@@ -1 +1 @@\n-before\n+after'
  },
  {
    path: 'packages/atoms/src/index.ts',
    kind: { type: 'update', move_path: null },
    diff: '@@ -1 +1,2 @@\n export {}\n+export { adapter }'
  },
  {
    path: 'packages/atoms/test/adapter.test.ts',
    kind: { type: 'create', move_path: null },
    diff: '@@ -0,0 +1,2 @@\n+test("adapter", () => {})\n+export {}'
  }
];

const raw = {
  method: 'item/completed',
  params: {
    item: {
      type: 'fileChange',
      id: 'call_file_change',
      changes,
      status: 'completed'
    }
  }
};

function pipeline() {
  const adapter = builtinAgentAdapters.find((candidate) => candidate.provider === 'codex');
  if (!adapter) throw new Error('Missing Codex adapter');
  const events = meshAgentNeutralStreamItems({
    id: 'mesh_codex_file_change',
    provider: 'codex',
    adapter,
    output: JSON.stringify(raw)
  });
  const cards = agentObservationCards(events, 'codex');
  const rows = observationTimelineRows(observationTimelineEntries(cards, 'codex'));
  return { cards, events, rows };
}

function visibleText(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function renderedText(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(renderedText).join(' ');
  if (!node || typeof node !== 'object') return '';
  return renderedText((node as { children?: unknown }).children);
}

test('Codex fileChange projects exact files and diff totals from app-server provenance', () => {
  const projected = pipeline();
  const card = projected.cards[0];
  const event = card?.payload.call as AgentObservationEvent | undefined;
  if (!card || !event) throw new Error('Expected Codex file change tool card');

  expect({
    event: { kind: event.kind, name: event.tool?.name },
    card: { kind: card.kind, streaming: card.streaming },
    view: codexFileChangeView(card.provenance.contractEvents)
  }).toEqual({
    event: { kind: 'tool-call', name: 'fileChange' },
    card: { kind: 'tool', streaming: false },
    view: {
      additions: 6,
      deletions: 2,
      files: [
        {
          additions: 2,
          deletions: 1,
          diff: changes[0]?.diff,
          kind: 'update',
          path: 'docs/plan.md'
        },
        {
          additions: 1,
          deletions: 1,
          diff: changes[1]?.diff,
          kind: 'update',
          path: 'packages/atoms/src/adapter.ts'
        },
        {
          additions: 1,
          deletions: 0,
          diff: changes[2]?.diff,
          kind: 'update',
          path: 'packages/atoms/src/index.ts'
        },
        {
          additions: 2,
          deletions: 0,
          diff: changes[3]?.diff,
          kind: 'create',
          path: 'packages/atoms/test/adapter.test.ts'
        }
      ],
      status: 'completed'
    }
  });
});

test('Codex fileChange timeline renders the exact read-only summary for a long file list', () => {
  const row = pipeline().rows[0];
  if (!row) throw new Error('Expected Codex file change timeline row');
  const markup = renderToStaticMarkup(
    <ObservationTimelineRowView
      provider="codex"
      row={row}
    />
  );

  expect(visibleText(markup)).toBe(
    'Edited 4 files +6 -2 docs/plan.md +2 -1 packages/atoms/src/adapter.ts +1 -1 packages/atoms/src/index.ts +1 -0 Show 1 more file'
  );
});

test('Codex fileChange timeline renders a bare history item as the read-only summary', () => {
  const adapter = builtinAgentAdapters.find((candidate) => candidate.provider === 'codex');
  const item = raw.params.item;
  if (!adapter) throw new Error('Missing Codex adapter');
  const events = meshAgentNeutralStreamItems({
    id: 'mesh_codex_bare_file_change',
    provider: 'codex',
    adapter,
    output: JSON.stringify(item)
  });
  const cards = agentObservationCards(events, 'codex');
  const row = observationTimelineRows(observationTimelineEntries(cards, 'codex'))[0];
  if (!row) throw new Error('Expected bare Codex file change timeline row');
  const markup = renderToStaticMarkup(
    <ObservationTimelineRowView
      provider="codex"
      row={row}
    />
  );

  expect(visibleText(markup)).toBe(
    'Edited 4 files +6 -2 docs/plan.md +2 -1 packages/atoms/src/adapter.ts +1 -1 packages/atoms/src/index.ts +1 -0 Show 1 more file'
  );
});

test('Codex fileChange controls reveal the remaining files and an individual diff', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const { act, create } = require('react-test-renderer') as {
    act: (run: () => void) => Promise<void>;
    create: (element: React.ReactElement) => {
      root: {
        findAllByType(type: string): Array<{ props: { onClick?: () => void }; children: unknown[] }>;
      };
      toJSON(): unknown;
      unmount(): void;
    };
  };
  const event = pipeline().cards[0]?.payload.call as AgentObservationEvent | undefined;
  const card = pipeline().cards[0];
  if (!event || !card) throw new Error('Expected Codex file change card');
  const view = codexFileChangeView(card.provenance.contractEvents);
  if (!view) throw new Error('Expected Codex file change view');
  let renderer: ReturnType<typeof create> | undefined;
  await act(() => {
    renderer = create(<CodexFileChangeCard view={view} />);
  });
  const mounted = renderer;
  if (!mounted) throw new Error('Expected mounted Codex file change card');

  const initialButtons = mounted.root.findAllByType('button');
  await act(() => initialButtons.at(-1)?.props.onClick?.());
  const expandedFiles = renderedText(mounted.toJSON()).replace(/\s+/g, ' ').trim();
  const fileButtons = mounted.root.findAllByType('button');
  await act(() => fileButtons[0]?.props.onClick?.());
  const expandedDiff = renderedText(mounted.toJSON()).replace(/\s+/g, ' ').trim();
  await act(() => mounted.unmount());

  expect({
    expandedDiff,
    expandedFiles
  }).toEqual({
    expandedDiff:
      'Edited 4 files + 6 - 2 docs/plan.md + 2 - 1 @@ -1,2 +1,3 @@ 1 - old 1 + new 2 + verified packages/atoms/src/adapter.ts + 1 - 1 packages/atoms/src/index.ts + 1 - 0 packages/atoms/test/adapter.test.ts + 2 - 0 Show fewer files',
    expandedFiles:
      'Edited 4 files + 6 - 2 docs/plan.md + 2 - 1 packages/atoms/src/adapter.ts + 1 - 1 packages/atoms/src/index.ts + 1 - 0 packages/atoms/test/adapter.test.ts + 2 - 0 Show fewer files'
  });
});
