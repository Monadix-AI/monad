import type { Meta, StoryObj } from '@storybook/react-vite';
import type { MonadMcpToolName } from '../../../packages/atoms/src/workplace-experiences/chat-room/components/observation/monad-mcp-projection.ts';

import {
  AllMonadMcpToolStoryCards,
  MonadMcpToolStoryCard
} from '../../../packages/atoms/stories/monad-mcp-tool-card-story-fixtures.tsx';

const meta = {
  title: 'Chat/Monad MCP Tool Cards',
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-background p-8 text-foreground">
        <div className="mx-auto w-full max-w-3xl">
          <Story />
        </div>
      </div>
    )
  ],
  parameters: { layout: 'fullscreen' }
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function toolStory(toolName: MonadMcpToolName): Story {
  return { render: () => <MonadMcpToolStoryCard toolName={toolName} /> };
}

export const AllTools: Story = { render: () => <AllMonadMcpToolStoryCards /> };
export const ProjectPost = toolStory('project_post');
export const ProjectAsk = toolStory('project_ask');
export const ProjectRead = toolStory('project_read');
export const ProjectInboxCheck = toolStory('project_inbox_check');
export const ProjectInboxAck = toolStory('project_inbox_ack');
export const AgentSend = toolStory('agent_send');
export const AgentRead = toolStory('agent_read');
export const SessionMembers = toolStory('session_members');
export const RuntimeInfo = toolStory('runtime_info');
export const ProjectPlanList = toolStory('project_plan_list');
export const ProjectPlanAdd = toolStory('project_plan_add');
export const ProjectPlanUpdate = toolStory('project_plan_update');
export const ProjectPlanDelete = toolStory('project_plan_delete');
