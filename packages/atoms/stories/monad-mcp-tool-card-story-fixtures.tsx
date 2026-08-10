import type {
  MonadMcpToolName,
  MonadMcpToolView
} from '../src/workplace-experiences/chat-room/components/observation/monad-mcp-projection.ts';
import type { Participant } from '../src/workplace-experiences/experience/types.ts';

import { ObservationToolCardShell } from '../src/workplace-experiences/chat-room/components/observation/card-shell.tsx';
import {
  MonadMcpToolCard,
  MonadMcpToolHeader
} from '../src/workplace-experiences/chat-room/components/observation/monad-mcp-card.tsx';
import { MONAD_MCP_TOOL_NAMES } from '../src/workplace-experiences/chat-room/components/observation/monad-mcp-projection.ts';

const STORY_MEMBER_IDENTITIES = new Map<string, Participant>([
  [
    'pmem_story_claude',
    {
      av: 'CC',
      icon: 'claude-code',
      id: 'pmem_story_claude',
      kind: 'agent',
      metadata: { agent: 'claude-code' },
      name: 'Claude Code',
      presence: 'online',
      tag: 'Claude'
    }
  ]
]);

const LONG_STORY_CONTENT = [
  'The observation card audit is complete.',
  'Read cards now preserve author identity and timestamps.',
  'Post cards keep the submitted message separate from delivery metadata.',
  'Long paths retain the complete filename.',
  'Copy controls remain available on hover and keyboard focus.',
  'Shell output stays unhighlighted.',
  'Line numbers no longer inherit syntax colors.',
  'Desktop and narrow layouts use the same content hierarchy.',
  'Focused tests and Storybook validation pass.'
].join('\n');

export const MONAD_MCP_STORY_VIEWS = {
  project_post: {
    action: 'project-post',
    attachments: [{ mime: 'text/markdown', name: 'status.md', path: '/workspace/status.md' }],
    durationMs: 84,
    input: { text: LONG_STORY_CONTENT },
    isError: false,
    output: { accepted: true, messageId: 'msg_01JMONADPOST' },
    status: 'completed',
    text: LONG_STORY_CONTENT,
    toolName: 'project_post'
  },
  project_ask: {
    action: 'project-ask',
    allowOther: true,
    durationMs: 42,
    input: { allowOther: true, mode: 'single', options: ['Keep current scope', 'Expand coverage'] },
    isError: false,
    mode: 'single',
    options: ['Keep current scope', 'Expand coverage'],
    output: { requestId: 'ask_01JMONAD', status: 'pending' },
    question: 'How should the next iteration be scoped?',
    status: 'completed',
    toolName: 'project_ask'
  },
  project_read: {
    action: 'project-read',
    durationMs: 63,
    input: { limit: 20 },
    isError: false,
    limit: 20,
    messages: [
      {
        attachments: [],
        createdAt: '2026-08-10T09:15:00Z',
        id: 'msg_story_read_1',
        name: 'Researcher',
        text: LONG_STORY_CONTENT
      },
      {
        attachments: [],
        createdAt: '2026-08-10T09:18:00Z',
        id: 'msg_story_read_2',
        name: 'Reviewer',
        text: 'Focused validation passed.'
      }
    ],
    output: {
      messages: [
        { author: 'Researcher', createdAt: '2026-08-10T09:15:00Z', text: 'The adapter mapping is complete.' },
        { author: 'Reviewer', createdAt: '2026-08-10T09:18:00Z', text: 'Focused validation passed.' }
      ]
    },
    status: 'completed',
    toolName: 'project_read'
  },
  project_inbox_check: {
    action: 'project-inbox-check',
    durationMs: 31,
    input: {},
    isError: false,
    output: {
      cursor: 42,
      messages: [{ from: 'agent_reviewer', ingressSeq: 42, text: 'Please verify the final story coverage.' }]
    },
    status: 'completed',
    toolName: 'project_inbox_check'
  },
  project_inbox_ack: {
    action: 'project-inbox-ack',
    cursor: 42,
    durationMs: 27,
    input: { cursor: 42 },
    isError: false,
    output: { acknowledged: true, cursor: 42 },
    status: 'completed',
    toolName: 'project_inbox_ack'
  },
  agent_send: {
    action: 'agent-send',
    attachments: [{ mime: 'text/markdown', path: '/workspace/review.md' }],
    durationMs: 55,
    input: { text: 'Can you review the Storybook coverage?', to: 'pmem_story_claude' },
    isError: false,
    output: { delivered: true, messageId: 'msg_01JAGENTSEND' },
    status: 'completed',
    text: 'Can you review the Storybook coverage?',
    to: 'pmem_story_claude',
    toolName: 'agent_send'
  },
  agent_read: {
    action: 'agent-read',
    durationMs: 38,
    input: { limit: 10, with: 'agent_reviewer' },
    isError: false,
    limit: 10,
    output: {
      messages: [{ from: 'agent_reviewer', sentAt: '2026-08-10T09:24:00Z', text: 'All 13 cards are covered.' }]
    },
    status: 'completed',
    toolName: 'agent_read',
    with: 'agent_reviewer'
  },
  session_members: {
    action: 'session-members',
    durationMs: 29,
    input: {},
    isError: false,
    output: {
      members: [
        { displayName: 'Codex', status: 'active' },
        { displayName: 'Claude Code', status: 'idle' }
      ]
    },
    status: 'completed',
    toolName: 'session_members'
  },
  runtime_info: {
    action: 'runtime-info',
    durationMs: 18,
    input: {},
    isError: false,
    output: {
      agent: 'Codex',
      cwd: '/Users/zeke/Projects/monad',
      provider: 'codex',
      sessionId: 'ses_storybook'
    },
    status: 'completed',
    toolName: 'runtime_info'
  },
  project_plan_list: {
    action: 'project-plan-list',
    durationMs: 34,
    input: {},
    isError: false,
    output: {
      plan: {
        todos: [
          { id: 'todo_1', status: 'completed', text: 'Inventory Monad MCP tools' },
          { id: 'todo_2', status: 'in_progress', text: 'Add Storybook coverage' },
          { id: 'todo_3', status: 'pending', text: 'Verify the complete catalog' }
        ]
      }
    },
    status: 'completed',
    toolName: 'project_plan_list'
  },
  project_plan_add: {
    action: 'project-plan-add',
    durationMs: 36,
    input: { text: 'Verify the complete catalog' },
    isError: false,
    output: { todo: { id: 'todo_3', status: 'pending', text: 'Verify the complete catalog' } },
    status: 'completed',
    toolName: 'project_plan_add'
  },
  project_plan_update: {
    action: 'project-plan-update',
    durationMs: 41,
    input: { id: 'todo_2', status: 'completed' },
    isError: false,
    output: { todo: { id: 'todo_2', status: 'completed', text: 'Add Storybook coverage' } },
    status: 'completed',
    toolName: 'project_plan_update'
  },
  project_plan_delete: {
    action: 'project-plan-delete',
    durationMs: 33,
    input: { id: 'todo_3' },
    isError: false,
    output: {
      plan: { todos: [{ id: 'todo_2', status: 'completed', text: 'Add Storybook coverage' }] }
    },
    status: 'completed',
    toolName: 'project_plan_delete'
  }
} satisfies Record<MonadMcpToolName, MonadMcpToolView>;

export function MonadMcpToolStoryCard({ toolName }: { toolName: MonadMcpToolName }) {
  const view = MONAD_MCP_STORY_VIEWS[toolName];
  return (
    <ObservationToolCardShell
      defaultOpen
      header={
        <MonadMcpToolHeader
          memberIdentities={STORY_MEMBER_IDENTITIES}
          quiet
          view={view}
        />
      }
      kind="mcp"
      status="success"
    >
      <MonadMcpToolCard view={view} />
    </ObservationToolCardShell>
  );
}

export function AllMonadMcpToolStoryCards() {
  return (
    <div className="grid gap-5">
      {MONAD_MCP_TOOL_NAMES.map((toolName) => (
        <MonadMcpToolStoryCard
          key={toolName}
          toolName={toolName}
        />
      ))}
    </div>
  );
}
