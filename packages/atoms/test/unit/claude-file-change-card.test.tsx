import type { AgentObservationEvent } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { builtinAgentAdapters } from '../../src/agent-adapters/index.ts';
import { agentObservationCards } from '../../src/workplace-experiences/chat-room/components/observation/card-projection.ts';
import {
  claudeFileChangeView,
  fileChangeStatus
} from '../../src/workplace-experiences/chat-room/components/observation/codex-file-change-card.tsx';
import {
  ObservationTimelineRowView,
  observationTimelineEntries,
  observationTimelineRows
} from '../../src/workplace-experiences/chat-room/components/observation/timeline.tsx';
import { meshAgentNeutralStreamItems } from '../../src/workplace-experiences/experience/mesh-agent-observation/mesh-agent-observation.ts';

function claudeFileToolPipeline(
  tool: 'Write' | 'Edit' | 'MultiEdit',
  input: Record<string, unknown>,
  toolUseResult?: Record<string, unknown>
) {
  const adapter = builtinAgentAdapters.find((candidate) => candidate.provider === 'claude-code');
  if (!adapter) throw new Error('Missing Claude Code adapter');
  const output = [
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: `toolu_${tool}`, name: tool, input }]
      }
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `toolu_${tool}`, content: 'Completed.' }]
      },
      ...(toolUseResult ? { tool_use_result: toolUseResult } : {})
    }
  ];
  const events = meshAgentNeutralStreamItems({
    adapter,
    id: `mesh_claude_${tool}`,
    output: output.map((record) => JSON.stringify(record)).join('\n'),
    provider: 'claude-code'
  });
  const cards = agentObservationCards(events, 'claude-code');
  const card = cards[0];
  const call = card?.payload.call as AgentObservationEvent | undefined;
  const result = card?.payload.result as AgentObservationEvent | undefined;
  const row = observationTimelineRows(observationTimelineEntries(cards, 'claude-code'))[0];
  if (!call || !row) throw new Error(`Expected Claude ${tool} card`);
  return {
    markup: renderToStaticMarkup(
      <ObservationTimelineRowView
        provider="claude-code"
        row={row}
      />
    ),
    view: claudeFileChangeView(call, result)
  };
}

test('file changes normalize Codex and Claude running statuses before choosing the orb', () => {
  expect(['inProgress', 'in_progress', 'running', 'pending'].map(fileChangeStatus)).toEqual([
    'running',
    'running',
    'running',
    'running'
  ]);
});

test('Claude Edit uses the provider structured patch to preserve real file line numbers', () => {
  const projected = claudeFileToolPipeline(
    'Edit',
    {
      file_path: '/workspace/src/existing.ts',
      old_string: 'const state = false;',
      new_string: 'const state = true;'
    },
    {
      filePath: '/workspace/src/existing.ts',
      structuredPatch: [
        {
          oldStart: 32,
          oldLines: 1,
          newStart: 32,
          newLines: 1,
          lines: ['-const state = false;', '+const state = true;']
        }
      ]
    }
  );

  expect(projected.view).toEqual({
    additions: 1,
    deletions: 1,
    files: [
      {
        additions: 1,
        deletions: 1,
        diff: '@@ -32,1 +32,1 @@\n-const state = false;\n+const state = true;',
        kind: 'update',
        path: '/workspace/src/existing.ts'
      }
    ],
    status: 'completed'
  });
});

test('Claude Write renders through the shared file-edit card', () => {
  const projected = claudeFileToolPipeline('Write', {
    file_path: '/workspace/src/new-file.ts',
    content: 'export const ready = true;\n'
  });

  expect({
    sharedCard: projected.markup.includes('data-codex-file-change-card="true"'),
    toolKind: /data-tool-kind="([^"]+)"/.exec(projected.markup)?.[1],
    view: projected.view
  }).toEqual({
    sharedCard: true,
    toolKind: 'file-change',
    view: {
      additions: 1,
      deletions: 0,
      files: [
        {
          additions: 1,
          deletions: 0,
          diff: '@@ -1,0 +1,1 @@\n+export const ready = true;',
          kind: 'write',
          path: '/workspace/src/new-file.ts'
        }
      ],
      status: 'completed'
    }
  });
});

test('Claude Edit renders its replacement through the shared file-edit card', () => {
  const projected = claudeFileToolPipeline('Edit', {
    file_path: '/workspace/src/existing.ts',
    old_string: 'const state = false;',
    new_string: 'const state = true;'
  });

  expect({
    sharedCard: projected.markup.includes('data-codex-file-change-card="true"'),
    view: projected.view
  }).toEqual({
    sharedCard: true,
    view: {
      additions: 1,
      deletions: 1,
      files: [
        {
          additions: 1,
          deletions: 1,
          diff: '@@ -1,1 +1,1 @@\n-const state = false;\n+const state = true;',
          kind: 'update',
          path: '/workspace/src/existing.ts',
          positionUnknown: true
        }
      ],
      status: 'completed'
    }
  });
});

test('Claude MultiEdit combines every replacement in the shared file-edit card', () => {
  const projected = claudeFileToolPipeline('MultiEdit', {
    file_path: '/workspace/src/multiple.ts',
    edits: [
      { old_string: 'const first = false;', new_string: 'const first = true;' },
      { old_string: 'const second = 0;', new_string: 'const second = 1;' }
    ]
  });

  expect({
    sharedCard: projected.markup.includes('data-codex-file-change-card="true"'),
    view: projected.view
  }).toEqual({
    sharedCard: true,
    view: {
      additions: 2,
      deletions: 2,
      files: [
        {
          additions: 2,
          deletions: 2,
          diff: '@@ -1,1 +1,1 @@\n-const first = false;\n+const first = true;\n@@ -1,1 +1,1 @@\n-const second = 0;\n+const second = 1;',
          kind: 'update',
          path: '/workspace/src/multiple.ts',
          positionUnknown: true
        }
      ],
      status: 'completed'
    }
  });
});
