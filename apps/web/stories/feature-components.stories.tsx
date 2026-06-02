import type { CommandItem, ProjectId, UIApprovalDisplay } from '@monad/protocol';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { SessionCommandMenuItem } from '#/features/session/command-menu';

import { TooltipProvider } from '@monad/ui';
import { useEffect } from 'react';

import { I18nProvider } from '#/components/I18nProvider';
import { ApprovalDisplayCard } from '#/features/session/ApprovalDisplayCard';
import { CommandMenu } from '#/features/session/CommandMenu';
import { ComposerQueueStack } from '#/features/session/ComposerQueueStack';
import { FileReadPreview, UnifiedDiffPreview } from '#/features/session/FileToolPreview';
import { MemorySummaryDivider } from '#/features/session/MemorySummaryDivider';
import { MessageBody } from '#/features/session/MessageBody';
import { ProjectDebugConsole } from '#/features/workplace/debug/ProjectDebugConsole';
import { MonadRuntimeContext } from '#/lib/monad-runtime-context';
import { appendProjectDebugTrace, clearProjectDebugTrace } from '#/lib/project-debug-trace';

const meta = {
  title: 'Web/Feature Components',
  parameters: {
    layout: 'fullscreen'
  }
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const frameClassName = 'min-h-screen bg-background p-8 text-foreground';

const noop = () => undefined;

const mockCommands = [
  {
    aliases: [],
    description: 'Create a follow-up branch from the current task.',
    enabled: true,
    group: 'Conversation',
    id: 'branch',
    name: 'Branch',
    source: 'builtin',
    type: 'action'
  },
  {
    aliases: [],
    description: 'Load the local project context before answering.',
    enabled: true,
    icon: '📚',
    id: 'global:repo-context',
    name: 'Repo Context',
    source: 'custom',
    sourceName: 'Global',
    type: 'skill',
    version: '1.2.0'
  }
] satisfies CommandItem[];

const approvalDisplays = [
  {
    defaultScope: 'session',
    kind: 'resource-approval',
    operation: 'read',
    rememberScopes: ['session', 'global'],
    resource: 'path',
    subject: '/Users/test/Projects/monad/apps/web/src/features/session/SessionRoute.tsx'
  },
  {
    defaultScope: 'once',
    kind: 'resource-approval',
    operation: 'execute',
    rememberScopes: ['once', 'session'],
    resource: 'network',
    subject: 'https://api.github.com/repos/monad/monad'
  }
] satisfies UIApprovalDisplay[];

const commandMenuItems = [
  {
    hint: 'Create a new task branch from the current message and keep the transcript context attached.',
    insert: '/branch ',
    key: 'branch',
    label: 'Branch',
    labelMatches: [0, 1],
    section: 'Commands',
    typeBadge: 'Command'
  },
  {
    badge: 'G',
    badgeTitle: 'Global',
    hint: 'Load repository conventions, local decisions, and package boundaries before making code changes.',
    icon: '📚',
    insert: '/global:repo-context ',
    key: 'global:repo-context',
    label: 'Repo Context',
    labelMatches: [0, 5],
    section: 'Skills',
    typeBadge: 'Skill',
    version: '1.2.0'
  },
  {
    badge: 'P',
    badgeTitle: 'Atom Pack: git-tools',
    hint: 'Inspect the current Git state and summarize modified files.',
    insert: '/atom-pack:git-tools:status ',
    key: 'atom-pack:git-tools:status',
    label: 'Git Status',
    section: 'Skills',
    typeBadge: 'Skill',
    version: '0.4.1'
  }
] satisfies SessionCommandMenuItem[];

function StoryFrame({ children, className = frameClassName }: { children: React.ReactNode; className?: string }) {
  return (
    <I18nProvider>
      <TooltipProvider>
        <div className={className}>{children}</div>
      </TooltipProvider>
    </I18nProvider>
  );
}

function DebugConsoleFixture() {
  useEffect(() => {
    clearProjectDebugTrace();
    appendProjectDebugTrace({
      data: { method: 'GET', path: '/api/projects/prj_story/messages', status: 200 },
      direction: 'output',
      label: 'http.response',
      layer: 'http',
      sessionId: 'prj_story'
    });
    appendProjectDebugTrace({
      data: { id: 'evt_story', type: 'message.delta', payload: { text: 'Streaming update' } },
      direction: 'event',
      label: 'message.delta',
      layer: 'sse',
      sessionId: 'prj_story'
    });
    appendProjectDebugTrace({
      data: { level: 50, msg: 'External agent failed to attach', name: 'external-agent' },
      direction: 'error',
      label: 'external_agent.attach_failed',
      layer: 'log',
      sessionId: 'prj_story'
    });
  }, []);

  return (
    <MonadRuntimeContext.Provider
      value={
        {
          baseUrl: 'http://127.0.0.1:3000',
          client: {
            streamEvents: () => noop,
            streamSessionLogs: () => noop
          },
          switchDaemonConnection: noop
        } as never
      }
    >
      <ProjectDebugConsole
        onClose={noop}
        projectId={'prj_story' as ProjectId}
      />
    </MonadRuntimeContext.Provider>
  );
}

export const SessionMessages: Story = {
  render: () => (
    <StoryFrame>
      <div className="grid max-w-3xl gap-4">
        <div className="rounded-md border bg-card p-4">
          <div className="mb-2 font-medium text-muted-foreground text-xs uppercase">User message with chips</div>
          <MessageBody
            commands={mockCommands}
            isUser
            onSkillPreview={noop}
            text={'/branch after this, use /global:repo-context before touching apps/web.'}
          />
        </div>
        <div className="rounded-md border bg-card p-4">
          <div className="mb-2 font-medium text-muted-foreground text-xs uppercase">Assistant markdown</div>
          <MessageBody
            isUser={false}
            text={'Implemented **storybook coverage** for `apps/web`.\n\n- Typecheck passes\n- Static build passes'}
          />
        </div>
        <div className="rounded-md border bg-card p-4">
          <div className="mb-2 font-medium text-muted-foreground text-xs uppercase">Assistant card</div>
          <MessageBody
            data={{
              actions: [
                { label: 'Open docs', url: 'https://storybook.js.org/docs' },
                { label: 'Unsafe link', url: 'javascript:alert(1)' }
              ],
              body: 'A model-produced card with one safe link and one disabled unsafe action.',
              title: 'Storybook task summary'
            }}
            isUser={false}
            text="Storybook task summary"
            type="card"
          />
        </div>
      </div>
    </StoryFrame>
  )
};

export const ApprovalCards: Story = {
  render: () => (
    <StoryFrame>
      <div className="grid max-w-2xl gap-4">
        {approvalDisplays.map((display) => (
          <ApprovalDisplayCard
            display={display}
            key={`${display.resource}:${display.subject}`}
          />
        ))}
      </div>
    </StoryFrame>
  )
};

export const FileToolPreviews: Story = {
  render: () => (
    <StoryFrame>
      <div className="grid max-w-5xl gap-5">
        <FileReadPreview
          offset={120}
          output={[
            'export function StorybookStatus({ ready }: { ready: boolean }) {',
            "  return ready ? 'ready' : 'pending';",
            '}'
          ].join('\n')}
          path="apps/web/src/features/storybook-status.tsx"
        />
        <UnifiedDiffPreview
          display={{
            afterText: '',
            beforeText: null,
            diff: [
              'diff --git a/apps/web/stories/example.tsx b/apps/web/stories/example.tsx',
              'index 1111111..2222222 100644',
              '--- a/apps/web/stories/example.tsx',
              '+++ b/apps/web/stories/example.tsx',
              '@@ -1,4 +1,5 @@',
              " import { Button } from '@monad/ui';",
              '',
              '-export const Basic = () => <Button>Run</Button>;',
              '+export const Primary = () => <Button>Run</Button>;',
              '+export const Secondary = () => <Button variant="secondary">Queue</Button>;'
            ].join('\n'),
            diffStat: { added: 2, removed: 1 },
            path: 'apps/web/stories/example.tsx',
            type: 'diff',
            warning: 'Preview uses a generated diff fixture.'
          }}
        />
      </div>
    </StoryFrame>
  )
};

export const ComposerQueue: Story = {
  render: () => (
    <StoryFrame>
      <div className="relative h-72 max-w-xl rounded-md border bg-card p-6">
        <ComposerQueueStack
          cancelLabel="Cancel"
          className="group pointer-events-none absolute right-6 bottom-16 z-20 h-20 w-80 bg-transparent"
          items={[
            { text: 'Also add dark-mode screenshots after the first build completes.' },
            { text: 'Check the generated route tree before committing.' },
            { text: 'Mention any warning from Storybook build in the final report.' }
          ]}
          onCancel={noop}
          onRemove={noop}
          onSteerNow={noop}
          steerNowLabel="Steer now"
        />
        <div className="absolute right-6 bottom-6 left-6 rounded-md border bg-background px-3 py-2 text-muted-foreground text-sm">
          Composer input frame
        </div>
      </div>
    </StoryFrame>
  )
};

export const SlashCommandMenu: Story = {
  render: () => (
    <StoryFrame>
      <div className="chat-input-frame fixed right-8 bottom-8 left-8 mx-auto max-w-2xl rounded-lg border bg-card p-3 shadow-lg">
        <div className="composer-tiptap-input min-h-20 rounded-md bg-background p-3 text-sm">/br</div>
        <CommandMenu
          activeSkill={1}
          items={commandMenuItems}
          loading={false}
          onApply={noop}
          onHover={noop}
        />
      </div>
    </StoryFrame>
  )
};

export const MemorySummaryStates: Story = {
  render: () => (
    <StoryFrame>
      <div className="grid max-w-4xl gap-6">
        <MemorySummaryDivider
          item={{
            summary:
              'The previous transcript established the Storybook setup, Bun dev integration, and build verification commands.'
          }}
        />
        <MemorySummaryDivider compactStatus="noop" />
        <MemorySummaryDivider pending />
      </div>
    </StoryFrame>
  )
};

export const DeveloperDebugConsole: Story = {
  render: () => (
    <StoryFrame className="min-h-screen bg-background text-foreground">
      <div className="p-8 text-muted-foreground text-sm">Debug console fixture</div>
      <DebugConsoleFixture />
    </StoryFrame>
  )
};
