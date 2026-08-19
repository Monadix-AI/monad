import type { AgentObservationEvent, MeshAgentObservationEvent } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { claudeCodeObservationProjection } from '../../src/agent-adapters/claude-code/observation.ts';
import { codexObservationProjection } from '../../src/agent-adapters/codex/observation/index.ts';
import { geminiObservationProjection } from '../../src/agent-adapters/gemini/observation.ts';
import { hermesObservationProjection } from '../../src/agent-adapters/hermes/observation.ts';
import { openClawObservationProjection } from '../../src/agent-adapters/openclaw/observation.ts';
import { qwenObservationProjection } from '../../src/agent-adapters/qwen/observation.ts';
import { agentObservationCards } from '../../src/workplace-experiences/chat-room/components/observation/card-projection.ts';
import {
  ObservationToolCardShell,
  observationElapsedSeconds
} from '../../src/workplace-experiences/chat-room/components/observation/card-shell.tsx';
import {
  ShellToolHeader,
  shellToolView
} from '../../src/workplace-experiences/chat-room/components/observation/shell-card.tsx';
import {
  ObservationTimelineRowView,
  observationTimelineEntries,
  observationTimelineRows
} from '../../src/workplace-experiences/chat-room/components/observation/timeline.tsx';

const observation = {
  id: 'observation-shell',
  role: 'tool',
  text: 'Tool call shell',
  source: 'unknown',
  provenance: { rawEvents: [{}] }
} satisfies MeshAgentObservationEvent;

test('provider adapters classify their native shell tools into the neutral shell category', () => {
  const classifications = [
    codexObservationProjection.toolCategory?.(observation, { name: 'command_execution' }),
    claudeCodeObservationProjection.toolCategory?.(observation, { name: 'Bash' }),
    geminiObservationProjection.toolCategory?.(observation, { name: 'run_shell_command' }),
    qwenObservationProjection.toolCategory?.(observation, { name: 'run_shell_command' }),
    hermesObservationProjection.toolCategory?.(observation, { name: 'terminal' }),
    openClawObservationProjection.toolCategory?.(observation, { name: 'exec' }),
    codexObservationProjection.toolCategory?.(observation, { name: 'Read' })
  ];
  expect(classifications).toEqual(['shell', 'shell', 'shell', 'shell', 'shell', 'shell', undefined]);
});

test('the shell card projection normalizes provider command inputs and result metadata', () => {
  const call = {
    id: 'shell-call',
    kind: 'tool-call',
    streaming: false,
    tool: {
      name: 'command_execution',
      category: 'shell',
      callId: 'shell-1',
      input: { cmd: ['bun', 'test'] },
      cwd: '/workspace'
    },
    provenance: { contractEvents: [{}] }
  } satisfies AgentObservationEvent;
  const result = {
    id: 'shell-result',
    kind: 'tool-result',
    streaming: false,
    tool: {
      name: 'command_execution',
      callId: 'shell-1',
      output: ' .../canvas.ts | 1 +\n .../projection.ts | 59 +++\n',
      status: 'completed',
      exitCode: 0,
      durationMs: 420
    },
    provenance: { contractEvents: [{}] }
  } satisfies AgentObservationEvent;

  expect(shellToolView(call, result, 'codex')).toEqual({
    command: 'bun test',
    cwd: '/workspace',
    durationMs: 420,
    exitCode: 0,
    output: ' .../canvas.ts | 1 +\n .../projection.ts | 59 +++\n',
    provider: 'codex',
    status: 'completed',
    type: 'command_execution'
  });
  expect(shellToolView(call, undefined, 'codex')).toEqual({
    command: 'bun test',
    cwd: '/workspace',
    provider: 'codex',
    type: 'command_execution'
  });
});

test('the Claude shell card uses the Shell title and follows it with the description summary', () => {
  const call = {
    id: 'claude-shell-call',
    kind: 'tool-call',
    streaming: false,
    tool: {
      name: 'Bash',
      category: 'shell',
      callId: 'claude-shell-1',
      input: {
        command: 'git status --short && ls packages/atoms/src/workplace-experiences/chat-room/',
        description: 'Check repo status and chat-room dir'
      }
    },
    provenance: { contractEvents: [{}] }
  } satisfies AgentObservationEvent;

  const view = shellToolView(call, undefined, 'claude-code');
  if (!view) throw new Error('Expected Claude shell card view');
  const header = renderToStaticMarkup(<ShellToolHeader view={view} />);

  expect({ header: visibleText(header), view }).toEqual({
    header: 'Tool call Shell · Check repo status and chat-room dir In progress',
    view: {
      command: 'git status --short && ls packages/atoms/src/workplace-experiences/chat-room/',
      provider: 'claude-code',
      summary: 'Check repo status and chat-room dir',
      type: 'Bash'
    }
  });
});

test('the Codex shell header uses the shared Shell title', () => {
  const call = {
    id: 'codex-shell-call',
    kind: 'tool-call',
    streaming: false,
    tool: {
      name: 'commandExecution',
      category: 'shell',
      callId: 'codex-shell-1',
      input: { command: 'rg -n "HANDOFF|Screen|Collecting|Evidence|Publish" packages/atoms' }
    },
    provenance: { contractEvents: [{}] }
  } satisfies AgentObservationEvent;
  const view = shellToolView(call, undefined, 'codex');
  if (!view) throw new Error('Expected Codex shell card view');
  const header = renderToStaticMarkup(<ShellToolHeader view={view} />);

  expect(visibleText(header)).toBe('Tool call Shell In progress');
});

test('shell and generic tool timeline cards render with distinct icon kinds', () => {
  const toolKind = (category: 'shell' | undefined, name: string) => {
    const callId = `${name}-call`;
    const call = {
      id: `${callId}-input`,
      kind: 'tool-call',
      streaming: false,
      tool: {
        name,
        ...(category ? { category } : {}),
        callId,
        input: category === 'shell' ? { command: 'git status' } : { query: 'read tool' }
      },
      provenance: { contractEvents: [{}] }
    } satisfies AgentObservationEvent;
    const result = {
      id: `${callId}-output`,
      kind: 'tool-result',
      streaming: false,
      tool: { name, callId, output: 'done', status: 'completed' },
      provenance: { contractEvents: [{}] }
    } satisfies AgentObservationEvent;
    const cards = agentObservationCards([call, result], 'claude-code');
    const row = observationTimelineRows(observationTimelineEntries(cards, 'claude-code'))[0];
    if (!row) throw new Error(`Expected ${name} timeline row`);
    const markup = renderToStaticMarkup(
      <ObservationTimelineRowView
        provider="claude-code"
        row={row}
      />
    );
    return /data-tool-kind="([^"]+)"/.exec(markup)?.[1];
  };

  expect([toolKind('shell', 'Bash'), toolKind(undefined, 'ToolSearch')]).toEqual(['command', 'tool']);
});

test('running tool kinds replace their static icon and status dot with the solving orb', () => {
  const rendered = (kind: 'command' | 'file' | 'file-change' | 'mcp' | 'tool') => {
    const markup = renderToStaticMarkup(
      <ObservationToolCardShell
        header={<span>Running</span>}
        kind={kind}
        status="running"
      >
        <span>Body</span>
      </ObservationToolCardShell>
    );
    return {
      elapsed: markup.includes('data-slot="observation-running-duration">0s</span>'),
      expandedRail: markup.includes('border-l'),
      orb: /data-orb-state="([^"]+)"/.exec(markup)?.[1],
      statusDot: markup.includes('data-slot="observation-tool-status"'),
      toolKind: /data-tool-kind="([^"]+)"/.exec(markup)?.[1]
    };
  };

  expect([rendered('file'), rendered('file-change'), rendered('command'), rendered('mcp'), rendered('tool')]).toEqual([
    { elapsed: true, expandedRail: false, orb: 'solving', statusDot: false, toolKind: 'file' },
    { elapsed: true, expandedRail: false, orb: 'solving', statusDot: false, toolKind: 'file-change' },
    { elapsed: true, expandedRail: false, orb: 'solving', statusDot: false, toolKind: 'command' },
    { elapsed: true, expandedRail: false, orb: 'solving', statusDot: false, toolKind: 'mcp' },
    { elapsed: true, expandedRail: false, orb: 'solving', statusDot: false, toolKind: 'tool' }
  ]);
});

test('running tool elapsed time advances at one-second boundaries', () => {
  expect([999, 1000, 1999, 2000].map((now) => observationElapsedSeconds(0, now))).toEqual([0, 1, 1, 2]);
});

test('visible text decoding applies HTML entities exactly once', () => {
  expect(visibleText('<span>&amp;quot; &quot; &amp;amp;</span>')).toBe('&quot; " &amp;');
});

function visibleText(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}
