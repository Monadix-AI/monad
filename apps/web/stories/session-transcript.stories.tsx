import type { Meta, StoryObj } from '@storybook/react-vite';

import { TooltipProvider } from '@monad/ui';

import { MemorySummaryDivider } from '#/features/session/MemorySummaryDivider';
import { ToolStepView } from '#/features/session/ToolStepView';
import {
  ApprovalExample,
  assistantMessage,
  BranchRestoreExample,
  ClarificationExample,
  CompactExample,
  CompleteSessionExample,
  directiveMessage,
  ExternalLoginExample,
  failedTool,
  MessageExample,
  parallelTools,
  reasoningMessage,
  runningTool,
  SessionStoryFrame,
  StoryCase,
  SummaryTurnExample,
  skillTool,
  successfulTool,
  userMessage
} from './session-transcript-story-fixtures';

const meta = {
  title: 'Chat/Session Transcript',
  decorators: [
    (Story) => (
      <TooltipProvider>
        <SessionStoryFrame>
          <Story />
        </SessionStoryFrame>
      </TooltipProvider>
    )
  ],
  parameters: { layout: 'fullscreen' }
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const UserMessage: Story = {
  render: () => (
    <StoryCase>
      <div data-story-case="user-message">
        <MessageExample message={userMessage} />
      </div>
    </StoryCase>
  )
};

export const AssistantMessage: Story = {
  render: () => (
    <StoryCase>
      <div data-story-case="assistant-message">
        <MessageExample message={assistantMessage} />
      </div>
    </StoryCase>
  )
};

export const Reasoning: Story = {
  render: () => (
    <StoryCase>
      <div data-story-case="reasoning">
        <MessageExample message={reasoningMessage} />
      </div>
    </StoryCase>
  )
};

export const Directive: Story = {
  render: () => (
    <StoryCase>
      <div data-story-case="directive">
        <MessageExample message={directiveMessage} />
      </div>
    </StoryCase>
  )
};

export const SingleTool: Story = {
  render: () => (
    <StoryCase>
      <div data-story-case="single-tool">
        <ToolStepView step={successfulTool} />
      </div>
    </StoryCase>
  )
};

export const ParallelTools: Story = {
  render: () => (
    <StoryCase>
      <div data-story-case="parallel-tools">
        <ToolStepView step={parallelTools} />
      </div>
    </StoryCase>
  )
};

export const SkillTool: Story = {
  render: () => (
    <StoryCase>
      <div data-story-case="skill-tool">
        <ToolStepView step={skillTool} />
      </div>
    </StoryCase>
  )
};

export const ExternalAgentLogin: Story = {
  render: () => (
    <StoryCase>
      <div data-story-case="external-agent-login">
        <ExternalLoginExample />
      </div>
    </StoryCase>
  )
};

export const MemorySummary: Story = {
  render: () => (
    <StoryCase>
      <div data-story-case="memory-summary">
        <MemorySummaryDivider item={{ summary: 'Earlier transcript context summarized for the next turn.' }} />
      </div>
    </StoryCase>
  )
};

export const Compact: Story = {
  render: () => (
    <StoryCase>
      <div data-story-case="compact">
        <CompactExample status="done" />
      </div>
    </StoryCase>
  )
};

export const BranchRestore: Story = {
  render: () => (
    <StoryCase>
      <div data-story-case="branch-restore">
        <BranchRestoreExample />
      </div>
    </StoryCase>
  )
};

export const SummaryTurn: Story = {
  render: () => (
    <StoryCase>
      <div data-story-case="summary-turn">
        <SummaryTurnExample />
      </div>
    </StoryCase>
  )
};

export const GenericApproval: Story = {
  render: () => (
    <StoryCase>
      <div data-story-case="generic-approval">
        <ApprovalExample />
      </div>
    </StoryCase>
  )
};

export const ResourceApproval: Story = {
  render: () => (
    <StoryCase>
      <div data-story-case="resource-approval">
        <ApprovalExample resource />
      </div>
    </StoryCase>
  )
};

export const Clarification: Story = {
  render: () => (
    <StoryCase>
      <div data-story-case="clarification">
        <ClarificationExample />
      </div>
    </StoryCase>
  )
};

export const ToolStates: Story = {
  render: () => (
    <StoryCase>
      <ToolStepView step={runningTool} />
      <ToolStepView step={successfulTool} />
      <ToolStepView step={failedTool} />
    </StoryCase>
  )
};

export const CompactStates: Story = {
  render: () => (
    <StoryCase>
      <CompactExample status="pending" />
      <CompactExample status="done" />
      <CompactExample status="noop" />
    </StoryCase>
  )
};

export const CompleteChatSession: Story = {
  render: () => (
    <StoryCase>
      <div data-story-case="complete-chat-session">
        <CompleteSessionExample />
      </div>
    </StoryCase>
  )
};
