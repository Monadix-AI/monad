import type { ApprovalScope, SessionId } from '@monad/protocol';
import type { ReactNode } from 'react';
import type { Msg } from '#/features/session/ChatMessage';
import type { PendingApproval } from '#/features/session/session-route-contract';
import type { ToolGroupItem, ToolItem } from '#/features/session/ToolStepView';

import { useState } from 'react';

import { Message } from '#/features/session/ChatMessage';
import { ExternalAgentLoginCardView } from '#/features/session/ExternalAgentLoginCard';
import { MemorySummaryDivider } from '#/features/session/MemorySummaryDivider';
import { ApprovalCard, ClarifyPrompt } from '#/features/session/SessionActionCards';
import { SummaryTranscriptTurn } from '#/features/session/SessionTranscript';
import { ToolStepView } from '#/features/session/ToolStepView';

const STORY_SESSION_ID = 'story-session' as SessionId;

export function SessionStoryFrame({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-background p-8 text-foreground">{children}</div>;
}

export function StoryCase({ children }: { children: ReactNode }) {
  return <div className="mx-auto grid w-full max-w-3xl gap-5">{children}</div>;
}

export const userMessage: Msg = {
  id: 'story-user',
  role: 'user',
  text: 'Show every transcript card in Storybook.'
};

export const assistantMessage: Msg = {
  id: 'story-assistant',
  role: 'assistant',
  text: 'I will add representative stories, state variants, and complete transcript compositions.'
};

export const reasoningMessage: Msg = {
  id: 'story-reasoning',
  reasoning: 'First inventory the render discriminants, then map each kind to a production component.',
  role: 'assistant',
  text: 'The inventory covers both Chat Session and Chat Experience.'
};

export const directiveMessage: Msg = {
  id: 'story-directive',
  role: 'assistant',
  text: 'Compact completed · 12 messages summarized',
  type: 'directive'
};

export const successfulTool: ToolItem = {
  id: 'story-tool-ok',
  input: { command: 'bun run typecheck' },
  kind: 'tool',
  output: 'Typecheck passed',
  status: 'ok',
  tool: 'shell_exec'
};

export const runningTool: ToolItem = {
  id: 'story-tool-running',
  input: { query: 'transcript card kinds' },
  kind: 'tool',
  status: 'running',
  tool: 'repo_search'
};

export const failedTool: ToolItem = {
  errorCode: 'TEST_FAILED',
  id: 'story-tool-error',
  input: { command: 'bun run test' },
  kind: 'tool',
  output: 'AssertionError: missing story case',
  status: 'error',
  tool: 'shell_exec'
};

export const parallelTools: ToolGroupItem = {
  id: 'story-tool-group',
  kind: 'toolGroup',
  steps: [
    { ...successfulTool, id: 'story-parallel-one', input: { path: 'packages/ui' }, tool: 'read' },
    { ...successfulTool, id: 'story-parallel-two', input: { path: 'apps/web' }, tool: 'read' }
  ]
};

export const skillTool: ToolItem = {
  display: {
    body: 'Review the changed Storybook catalogs and report missing transcript variants.',
    context: 'inline',
    description: 'Checks transcript story coverage against production render branches.',
    name: 'storybook:transcript-review',
    tier: 'workspace',
    type: 'skill',
    version: '1.0.0'
  },
  id: 'story-skill',
  input: { name: 'storybook:transcript-review' },
  kind: 'tool',
  output: 'Coverage complete',
  status: 'ok',
  tool: 'skill'
};

export function MessageExample({ message }: { message: Msg }) {
  return (
    <Message
      assistantLabel="Monad"
      msg={message}
    />
  );
}

export function BranchRestoreExample() {
  const [action, setAction] = useState('Hover the message to reveal branch and restore actions.');
  return (
    <div className="grid gap-2">
      <Message
        assistantLabel="Monad"
        msg={{ ...userMessage, id: 'story-branch', text: 'Use this message as the new branch point.' }}
        onBranch={() => setAction('Branch callback invoked locally.')}
        onRestore={async () => {
          setAction('Restore callback invoked locally.');
          return true;
        }}
      />
      <span className="text-muted-foreground text-xs">{action}</span>
    </div>
  );
}

export function ExternalLoginExample() {
  const [requested, setRequested] = useState(false);
  return (
    <ExternalAgentLoginCardView
      error={requested ? 'Story-only sign-in request captured; no network call was made.' : null}
      isLoading={false}
      item={{
        agentName: 'Claude Code',
        id: 'story-login',
        kind: 'external_agent_login',
        provider: 'claude-code',
        reason: 'The provider session requires authentication.',
        seq: '2026-07-17T10:30:00.000Z'
      }}
      onLogin={() => setRequested(true)}
    />
  );
}

export function CompactExample({ status }: { status: 'done' | 'noop' | 'pending' }) {
  return (
    <MemorySummaryDivider
      compactStatus={status}
      item={status === 'pending' ? undefined : { summary: 'Earlier context condensed into a durable summary.' }}
      pending={status === 'pending'}
    />
  );
}

export function SummaryTurnExample() {
  return (
    <SummaryTranscriptTurn
      assistantLabel="Monad"
      item={{
        details: [reasoningMessage, successfulTool, directiveMessage],
        durationLabel: '8s',
        id: 'story-summary-turn',
        kind: 'summary_transcript_turn',
        status: 'done'
      }}
      sessionId={STORY_SESSION_ID}
    />
  );
}

const genericApproval: PendingApproval = {
  input: { command: 'bun run test', cwd: '/workspace/monad' },
  requestId: 'story-approval-generic',
  tool: 'shell_exec'
};

const resourceApproval: PendingApproval = {
  display: {
    defaultScope: 'session',
    kind: 'resource-approval',
    operation: 'write',
    rememberScopes: ['session', 'agent'],
    resource: 'path',
    subject: '/workspace/report.md'
  },
  key: '/workspace',
  requestId: 'story-approval-resource',
  tool: 'path_access'
};

export function ApprovalExample({ resource = false }: { resource?: boolean }) {
  const [decision, setDecision] = useState('No decision yet.');
  const approval = resource ? resourceApproval : genericApproval;
  const onApproval = (_approval: PendingApproval, allow: boolean, scope: ApprovalScope) => {
    setDecision(`${allow ? 'Allowed' : 'Denied'} for ${scope}.`);
  };
  return (
    <div className="grid gap-2">
      <ApprovalCard
        approval={approval}
        onApproval={onApproval}
      />
      <span className="text-muted-foreground text-xs">{decision}</span>
    </div>
  );
}

export function ClarificationExample() {
  const [answer, setAnswer] = useState('No answer yet.');
  return (
    <div className="grid gap-2">
      <ClarifyPrompt
        onAnswer={setAnswer}
        options={['Representative only', 'Include states', 'Include complete transcript']}
        question="Which Storybook coverage should be included?"
      />
      <span className="text-muted-foreground text-xs">Answer: {answer}</span>
    </div>
  );
}

export function CompleteSessionExample() {
  return (
    <div className="grid gap-5">
      <MessageExample message={userMessage} />
      <MessageExample message={reasoningMessage} />
      <ToolStepView step={successfulTool} />
      <ToolStepView step={parallelTools} />
      <ToolStepView step={skillTool} />
      <MessageExample message={directiveMessage} />
      <ExternalLoginExample />
      <MemorySummaryDivider item={{ summary: 'Previous transcript context summarized.' }} />
      <CompactExample status="done" />
      <BranchRestoreExample />
      <SummaryTurnExample />
      <ApprovalExample />
      <ApprovalExample resource />
      <ClarificationExample />
      <MessageExample message={assistantMessage} />
    </div>
  );
}
