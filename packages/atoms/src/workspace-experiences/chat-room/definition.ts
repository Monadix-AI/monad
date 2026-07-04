import type { WorkspaceExperienceDefinition } from '@monad/sdk-atom';

export const chatRoomWorkspaceExperience: WorkspaceExperienceDefinition = {
  id: 'chat-room',
  title: 'Chat',
  icon: 'message-square',
  entry: {
    type: 'host-component',
    component: 'chat-room'
  }
};
