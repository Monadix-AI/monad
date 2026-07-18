import type { ReactNode } from 'react';
import type { CommandCardView, ObservationVisualRole } from '../src';

import { useState } from 'react';

import {
  ApprovalResourceCard,
  AttachmentCard,
  Button,
  CommandCard,
  CommandCardHeader,
  DefaultObservationToolPair,
  FileReadCard,
  FileReadCardHeader,
  ObservationCard,
  ObservationMeta,
  ObservationText,
  RawInspectableCard,
  WorkspaceMessageCard,
  WorkspaceSystemEventCard
} from '../src';

export function ExperienceStoryFrame({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-background p-8 text-foreground">{children}</div>;
}

export function StoryCase({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-3xl">{children}</div>;
}

function AvatarToken({ label, tone = 'agent' }: { label: string; tone?: 'agent' | 'human' }) {
  return (
    <span
      className={
        tone === 'agent'
          ? 'flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/15 font-semibold text-primary text-xs'
          : 'flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground font-semibold text-background text-xs'
      }
    >
      {label}
    </span>
  );
}

function MessageHeader({ label, meta }: { label: string; meta: string }) {
  return (
    <div className="mb-1 flex items-center gap-2 text-xs">
      <span className="font-semibold">{label}</span>
      <span className="font-mono text-muted-foreground">{meta}</span>
    </div>
  );
}

export function HumanMessageExample({ failed = false, sending = false }: { failed?: boolean; sending?: boolean }) {
  return (
    <WorkspaceMessageCard
      align="end"
      avatar={
        <AvatarToken
          label="ZE"
          tone="human"
        />
      }
      body="Please inspect the session output and summarize the blockers."
      header={
        <MessageHeader
          label="Zeke"
          meta="10:30"
        />
      }
      retryAction={failed ? <Button size="sm">Retry message</Button> : undefined}
      sending={sending}
      tone="human"
    />
  );
}

export function AgentMessageExample() {
  return (
    <WorkspaceMessageCard
      align="start"
      avatar={<AvatarToken label="CX" />}
      body={
        <span>
          The shared cards are ready. I found one failing check in <code>SessionTranscript.tsx</code>.
        </span>
      }
      header={
        <MessageHeader
          label="Codex"
          meta="CLI · 10:31"
        />
      }
      tone="agent"
    />
  );
}

export function SystemEventExample({ developer = false }: { developer?: boolean }) {
  return (
    <WorkspaceSystemEventCard
      actor={<span className="font-semibold text-foreground">Codex</span>}
      badge={developer ? <span className="rounded-full bg-info/15 px-2 py-0.5 text-info text-xs">DEV</span> : undefined}
      body={<span>{developer ? 'updated the runtime directive' : 'joined the project'}</span>}
      timestamp={<span className="font-mono text-[11px]">10:32</span>}
    />
  );
}

export type AttachmentStoryState = 'download-only' | 'previewable';

export function AttachmentExample({ state = 'previewable' }: { state?: AttachmentStoryState }) {
  return (
    <AttachmentCard
      downloadLabel="Download"
      mime="text/plain"
      name="verification.log"
      onDownload={() => {}}
      onPreview={() => {}}
      path="/workspace/verification.log"
      previewable={state === 'previewable'}
      previewLabel="Preview"
      sizeLabel="2.4 KB"
    />
  );
}

export function ObservationExample({
  initialCollapsed = false,
  visualRole
}: {
  initialCollapsed?: boolean;
  visualRole: ObservationVisualRole;
}) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const text: Record<ObservationVisualRole, string> = {
    agent: 'I am comparing the two transcript render paths.',
    error: 'Provider model refresh failed.',
    system: 'Provider session resumed from persisted history.',
    tool: 'Tool call `repo_search` for shared card consumers.',
    user: 'Keep behavior controlled by the consumer.',
    warning: 'Provider plugin catalog warmup failed.'
  };
  return (
    <ObservationCard
      collapsed={collapsed}
      header={
        <ObservationMeta
          label={visualRole}
          showSource
          source="codex-app-server"
          title={`${visualRole} observation`}
        />
      }
      onCollapsedChange={setCollapsed}
      timestamp="2026-07-17T10:33:00.000Z"
      visualRole={visualRole}
    >
      <ObservationText
        observationRole={visualRole}
        text={text[visualRole]}
      />
    </ObservationCard>
  );
}

function commandView(status: 'error' | 'running' | 'success'): CommandCardView {
  if (status === 'running') {
    return {
      command: 'bun run typecheck',
      cwd: '/workspace/monad',
      provider: 'codex',
      status: 'running',
      type: 'commandExecution'
    };
  }
  return {
    command: 'bun run test',
    cwd: '/workspace/monad',
    durationMs: status === 'success' ? 1840 : 620,
    exitCode: status === 'success' ? 0 : 1,
    output: status === 'success' ? '18 pass\n0 fail' : '1 test failed\nAssertionError: expected shared card',
    provider: 'codex',
    status: status === 'success' ? 'completed' : 'failed',
    type: 'commandExecution'
  };
}

export function CommandExample({ status = 'success' }: { status?: 'error' | 'running' | 'success' }) {
  const [collapsed, setCollapsed] = useState(false);
  const view = commandView(status);
  return (
    <ObservationCard
      collapsed={collapsed}
      header={<CommandCardHeader view={view} />}
      onCollapsedChange={setCollapsed}
      visualRole="tool"
    >
      <CommandCard view={view} />
    </ObservationCard>
  );
}

export function FileReadExample() {
  const [collapsed, setCollapsed] = useState(false);
  const view = {
    content: 'export function SharedCard() {\n  return <article />;\n}',
    path: '/workspace/packages/ui/src/components/SharedCard.tsx',
    provider: 'claude-code',
    type: 'Read'
  };
  return (
    <ObservationCard
      collapsed={collapsed}
      header={<FileReadCardHeader view={view} />}
      onCollapsedChange={setCollapsed}
      visualRole="tool"
    >
      <FileReadCard view={view} />
    </ObservationCard>
  );
}

export function GenericToolPairExample() {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <ObservationCard
      collapsed={collapsed}
      header={
        <ObservationMeta
          compact
          label="tool call"
          source="gemini-cli"
          title="repo_search"
        />
      }
      onCollapsedChange={setCollapsed}
      visualRole="tool"
    >
      <DefaultObservationToolPair
        callText={'repo_search {"query":"chat cards"}'}
        callTool="repo_search"
        provider="gemini-cli"
        resultText="Found 12 matching symbols across 7 files."
        resultTool="repo_search_result"
      />
    </ObservationCard>
  );
}

export function ReadonlyApprovalExample() {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <ObservationCard
      collapsed={collapsed}
      header={
        <ObservationMeta
          compact
          label="system"
          source="claude-code"
          title="Approval requested"
        />
      }
      onCollapsedChange={setCollapsed}
      visualRole="system"
    >
      <ApprovalResourceCard
        defaultScope="provider-owned"
        defaultScopeLabel="Scope"
        operation="write"
        resourceLabel="File access"
        subject="/workspace/report.md"
      />
      <p className="mt-2 text-muted-foreground text-xs">
        Read-only provider observation. No Monad action is available.
      </p>
    </ObservationCard>
  );
}

export function RawJsonlExample() {
  const [open, setOpen] = useState(false);
  return (
    <RawInspectableCard
      labels={{ copy: 'Copy raw JSON', hide: 'Hide raw JSONL', show: 'Show raw JSONL' }}
      onCopy={() => {}}
      onOpenChange={setOpen}
      open={open}
      records={[
        { id: 'call', text: '{"type":"tool_call","name":"repo_search"}' },
        { id: 'result', text: '{"type":"tool_result","matches":12}' }
      ]}
    >
      <ObservationExample visualRole="tool" />
    </RawInspectableCard>
  );
}

export function CompleteExperienceExample() {
  return (
    <div className="grid gap-4">
      <HumanMessageExample />
      <SystemEventExample />
      <AgentMessageExample />
      <AttachmentExample />
      <SystemEventExample developer />
      <ObservationExample visualRole="user" />
      <ObservationExample visualRole="agent" />
      <ObservationExample visualRole="system" />
      <CommandExample status="success" />
      <FileReadExample />
      <GenericToolPairExample />
      <ReadonlyApprovalExample />
      <RawJsonlExample />
    </div>
  );
}
