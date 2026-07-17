import type { Meta, StoryObj } from '@storybook/react-vite';

import { TooltipProvider } from '../src';
import {
  AgentMessageExample,
  AttachmentExample,
  CommandExample,
  CompleteExperienceExample,
  ExperienceStoryFrame,
  FileReadExample,
  GenericToolPairExample,
  HumanMessageExample,
  ObservationExample,
  RawJsonlExample,
  ReadonlyApprovalExample,
  StoryCase,
  SystemEventExample
} from './chat-card-story-fixtures';

const meta = {
  title: 'Chat/Experience Cards',
  decorators: [
    (Story) => (
      <TooltipProvider>
        <ExperienceStoryFrame>
          <Story />
        </ExperienceStoryFrame>
      </TooltipProvider>
    )
  ],
  parameters: { layout: 'fullscreen' }
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const HumanMessage: Story = {
  render: () => (
    <StoryCase>
      <div data-story-case="human-message">
        <HumanMessageExample />
      </div>
    </StoryCase>
  )
};

export const AgentMessage: Story = {
  render: () => (
    <StoryCase>
      <div data-story-case="agent-message">
        <AgentMessageExample />
      </div>
    </StoryCase>
  )
};

export const SystemEvent: Story = {
  render: () => (
    <StoryCase>
      <div data-story-case="system-event">
        <SystemEventExample />
      </div>
    </StoryCase>
  )
};

export const DeveloperEvent: Story = {
  render: () => (
    <StoryCase>
      <div data-story-case="developer-event">
        <SystemEventExample developer />
      </div>
    </StoryCase>
  )
};

export const Attachment: Story = {
  render: () => (
    <StoryCase>
      <div data-story-case="attachment">
        <AttachmentExample state="expanded" />
      </div>
    </StoryCase>
  )
};

export const ObservationUser: Story = {
  render: () => (
    <StoryCase>
      <div data-story-case="observation-user">
        <ObservationExample visualRole="user" />
      </div>
    </StoryCase>
  )
};

export const ObservationAgent: Story = {
  render: () => (
    <StoryCase>
      <div data-story-case="observation-agent">
        <ObservationExample visualRole="agent" />
      </div>
    </StoryCase>
  )
};

export const ObservationTool: Story = {
  render: () => (
    <StoryCase>
      <div data-story-case="observation-tool">
        <ObservationExample visualRole="tool" />
      </div>
    </StoryCase>
  )
};

export const ObservationSystem: Story = {
  render: () => (
    <StoryCase>
      <div data-story-case="observation-system">
        <ObservationExample visualRole="system" />
      </div>
    </StoryCase>
  )
};

export const Command: Story = {
  render: () => (
    <StoryCase>
      <div data-story-case="command">
        <CommandExample />
      </div>
    </StoryCase>
  )
};

export const FileRead: Story = {
  render: () => (
    <StoryCase>
      <div data-story-case="file-read">
        <FileReadExample />
      </div>
    </StoryCase>
  )
};

export const GenericToolPair: Story = {
  render: () => (
    <StoryCase>
      <div data-story-case="generic-tool-pair">
        <GenericToolPairExample />
      </div>
    </StoryCase>
  )
};

export const ReadonlyApproval: Story = {
  render: () => (
    <StoryCase>
      <div data-story-case="readonly-approval">
        <ReadonlyApprovalExample />
      </div>
    </StoryCase>
  )
};

export const RawJsonl: Story = {
  render: () => (
    <StoryCase>
      <div data-story-case="raw-jsonl">
        <RawJsonlExample />
      </div>
    </StoryCase>
  )
};

export const MessageStates: Story = {
  render: () => (
    <StoryCase>
      <div className="grid gap-5">
        <HumanMessageExample sending />
        <HumanMessageExample failed />
      </div>
    </StoryCase>
  )
};

export const AttachmentStates: Story = {
  render: () => (
    <StoryCase>
      <div className="grid gap-4">
        <AttachmentExample />
        <AttachmentExample state="loading" />
        <AttachmentExample state="expanded" />
        <AttachmentExample state="error" />
      </div>
    </StoryCase>
  )
};

export const ObservationStates: Story = {
  render: () => (
    <StoryCase>
      <div className="grid gap-4">
        <ObservationExample
          initialCollapsed
          visualRole="agent"
        />
        <ObservationExample visualRole="agent" />
        <RawJsonlExample />
      </div>
    </StoryCase>
  )
};

export const CommandStates: Story = {
  render: () => (
    <StoryCase>
      <div className="grid gap-4">
        <CommandExample status="running" />
        <CommandExample status="success" />
        <CommandExample status="error" />
      </div>
    </StoryCase>
  )
};

export const CompleteChatExperience: Story = {
  render: () => (
    <StoryCase>
      <div data-story-case="complete-chat-experience">
        <CompleteExperienceExample />
      </div>
    </StoryCase>
  )
};
