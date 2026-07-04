import type { WorkspaceExperienceDefinition } from '@monad/sdk-atom';

export const chatRoomWorkspaceExperience: WorkspaceExperienceDefinition = {
  id: 'chat-room',
  title: 'Chat',
  icon: 'message-square',
  entry: {
    type: 'builtin',
    component: 'chat-room'
  }
};

export const graphicViewWorkspaceExperience: WorkspaceExperienceDefinition = {
  id: 'graphic-view',
  title: 'Activity',
  icon: 'git-fork',
  entry: {
    type: 'builtin',
    component: 'graphic-view'
  }
};

export const builtinWorkspaceExperiences = [chatRoomWorkspaceExperience, graphicViewWorkspaceExperience];
