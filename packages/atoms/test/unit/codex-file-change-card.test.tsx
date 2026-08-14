import type { AgentObservationEvent } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { parseUnifiedDiff } from '@monad/ui';
import { fireEvent, render } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';

import { builtinAgentAdapters } from '../../src/agent-adapters/index.ts';
import { agentObservationCards } from '../../src/agent-adapters/observation-cards.ts';
import {
  CodexFileChangeCard,
  type CodexFileChangeView,
  codexFileChangeView,
  FileChangeToolHeader
} from '../../src/workplace-experiences/chat-room/components/observation/codex-file-change-card.tsx';
import {
  ObservationTimelineRowView,
  observationTimelineEntries,
  observationTimelineRows
} from '../../src/workplace-experiences/chat-room/components/observation/timeline.tsx';
import { meshAgentNeutralStreamItems } from '../../src/workplace-experiences/experience/mesh-agent-observation/mesh-agent-observation.ts';
import { setupDomTestEnvironment } from '../dom-test-env.ts';

if (typeof document === 'undefined') await import('../register-dom-first.ts');

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
    .replace(/\/ /g, '/')
    .trim();
}

setupDomTestEnvironment();

function domText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  return Array.from(node.childNodes, domText).join(' ');
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
    event: { kind: 'tool-call', name: 'File change' },
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

test('Codex fileChange settles a started item when its completed result arrives', () => {
  const file = {
    path: 'src/client-logic.ts',
    kind: { type: 'add' },
    diff: 'export const ready = true;\n'
  };
  const view = codexFileChangeView([
    {
      method: 'item/started',
      params: { item: { type: 'fileChange', changes: [file], status: 'inProgress' } }
    },
    {
      method: 'item/completed',
      params: { item: { type: 'fileChange', changes: [file], status: 'completed' } }
    }
  ]);
  if (!view) throw new Error('Expected completed Codex file change view');

  expect({
    status: view.status,
    title: visibleText(renderToStaticMarkup(<FileChangeToolHeader view={view} />))
  }).toEqual({
    status: 'completed',
    title: 'tool call Created client-logic.ts'
  });
});

test('Codex add fileChange treats body content as additions with natural new-file line numbers', () => {
  const view = codexFileChangeView([
    {
      type: 'fileChange',
      changes: [
        {
          path: 'research-desk-hifi-prompt.md',
          kind: { type: 'add' },
          diff: '# Research Desk high-fidelity prompt\n\nMode: built-in image generation.\n'
        }
      ],
      status: 'completed'
    }
  ]);
  const diff = view?.files[0]?.diff;

  expect({
    totals: view ? { additions: view.additions, deletions: view.deletions } : undefined,
    rows: diff
      ? parseUnifiedDiff(diff).map((row) => ({ kind: row.kind, marker: row.marker, newLine: row.newLine }))
      : undefined
  }).toEqual({
    totals: { additions: 3, deletions: 0 },
    rows: [
      { kind: 'hunk', marker: '', newLine: null },
      { kind: 'addition', marker: '+', newLine: 1 },
      { kind: 'addition', marker: '+', newLine: 2 },
      { kind: 'addition', marker: '+', newLine: 3 }
    ]
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
    'tool call Edited 4 files +6 -2 docs/plan.md +2 -1 packages/atoms/src/adapter.ts +1 -1 packages/atoms/src/index.ts +1 -0 Show 1 more file'
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
    'tool call Edited 4 files +6 -2 docs/plan.md +2 -1 packages/atoms/src/adapter.ts +1 -1 packages/atoms/src/index.ts +1 -0 Show 1 more file'
  );
});

test('Codex fileChange controls reveal the remaining files and an individual diff', async () => {
  const event = pipeline().cards[0]?.payload.call as AgentObservationEvent | undefined;
  const card = pipeline().cards[0];
  if (!event || !card) throw new Error('Expected Codex file change card');
  const view = codexFileChangeView(card.provenance.contractEvents);
  if (!view) throw new Error('Expected Codex file change view');
  const rendered = render(<CodexFileChangeCard view={view} />);
  const initialButtons = rendered.getAllByRole('button');
  fireEvent.click(initialButtons.at(-1) as HTMLButtonElement);
  const expandedFiles = domText(rendered.container).replace(/\s+/g, ' ').replace(/\/ /g, '/').trim();
  const fileButtons = rendered.getAllByRole('button');
  fireEvent.click(fileButtons[0] as HTMLButtonElement);
  const expandedDiff = domText(rendered.container).replace(/\s+/g, ' ').replace(/\/ /g, '/').trim();

  expect({
    expandedDiff,
    expandedFiles
  }).toEqual({
    expandedDiff:
      '+ 6 - 2 docs/plan.md + 2 - 1 @@ -1,2 +1,3 @@ 1 - old 1 + new 2 + verified packages/atoms/src/adapter.ts + 1 - 1 packages/atoms/src/index.ts + 1 - 0 packages/atoms/test/adapter.test.ts + 2 - 0 Show fewer files',
    expandedFiles:
      '+ 6 - 2 docs/plan.md + 2 - 1 packages/atoms/src/adapter.ts + 1 - 1 packages/atoms/src/index.ts + 1 - 0 packages/atoms/test/adapter.test.ts + 2 - 0 Show fewer files'
  });
});

test('file change titles distinguish create and edit operations across running and completed states', () => {
  const title = (kind: string, status: string, files = 1) => {
    const markup = renderToStaticMarkup(
      <FileChangeToolHeader
        view={{
          additions: files,
          deletions: 0,
          files: Array.from({ length: files }, (_, index) => ({
            additions: 1,
            deletions: 0,
            kind,
            path: files === 1 ? '/workspace/result.ts' : `/workspace/result-${index}.ts`
          })),
          status
        }}
      />
    );
    return { fileIcon: markup.includes('data-file-icon="result.ts"'), text: visibleText(markup) };
  };

  expect([
    title('create', 'running'),
    title('create', 'completed'),
    title('create', 'running', 3),
    title('update', 'running'),
    title('update', 'completed'),
    title('update', 'completed', 4)
  ]).toEqual([
    { fileIcon: true, text: 'tool call Creating result.ts' },
    { fileIcon: true, text: 'tool call Created result.ts' },
    { fileIcon: false, text: 'tool call Creating 3 files' },
    { fileIcon: true, text: 'tool call Editing result.ts' },
    { fileIcon: true, text: 'tool call Edited result.ts' },
    { fileIcon: false, text: 'tool call Edited 4 files' }
  ]);
});

test('Codex fileChange rows truncate directories while retaining the complete filename', () => {
  const path = '/Users/zeke/Projects/monad/apps/web/src/components/workspace/research-desk-final.md';
  const markup = renderToStaticMarkup(
    <CodexFileChangeCard
      view={{
        additions: 1,
        deletions: 0,
        files: [{ additions: 1, deletions: 0, kind: 'update', path }],
        status: 'completed'
      }}
    />
  );
  expect({
    directory: markup.match(/data-slot="compact-file-path-directory"[^>]*>([^<]+)</)?.[1],
    filename: markup.match(/data-slot="compact-file-path-filename"[^>]*>([^<]+)</)?.[1],
    reusablePath: markup.includes('data-file-change-path="path"')
  }).toEqual({
    directory: '/Users/zeke/Projects/monad/apps/web/src/components/workspace/',
    filename: 'research-desk-final.md',
    reusablePath: true
  });
});

test('file change cards omit aggregate totals for one file and retain them for multiple files', () => {
  const markup = (files: CodexFileChangeView['files']) =>
    visibleText(
      renderToStaticMarkup(
        <CodexFileChangeCard
          view={{
            additions: files.reduce((total, file) => total + file.additions, 0),
            deletions: files.reduce((total, file) => total + file.deletions, 0),
            files,
            status: 'completed'
          }}
        />
      )
    );
  const first = { additions: 6, deletions: 6, kind: 'update', path: '/workspace/first.ts' };
  const second = { additions: 2, deletions: 1, kind: 'update', path: '/workspace/second.ts' };

  expect({
    multiple: markup([first, second]),
    single: markup([first])
  }).toEqual({
    multiple: '+8 -7 /workspace/first.ts +6 -6 /workspace/second.ts +2 -1',
    single: '/workspace/first.ts +6 -6'
  });
});
