import type { WorkspaceExperienceDefinition } from '@monad/sdk-atom';

export const graphicViewWorkspaceExperience: WorkspaceExperienceDefinition = {
  id: 'graphic-view',
  title: 'Activity',
  icon: 'git-fork',
  entry: {
    type: 'host-component',
    component: 'graphic-view'
  }
};
