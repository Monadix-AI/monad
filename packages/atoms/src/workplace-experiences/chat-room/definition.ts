import type { WorkplaceExperienceDefinition } from '@monad/sdk-experience';

export const chatRoomWorkplaceExperience: WorkplaceExperienceDefinition = {
  id: 'chat-room',
  title: 'Chat',
  icon: 'message-square',
  entry: {
    type: 'host-component',
    component: 'chat-room'
  }
};
