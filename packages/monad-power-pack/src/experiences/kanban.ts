import type { WorkspaceExperienceDefinition } from '@monad/sdk-atom';

export const kanbanWorkspaceExperience: WorkspaceExperienceDefinition = {
  id: 'kanban',
  title: 'Kanban',
  icon: 'git-fork',
  entry: {
    type: 'web-component',
    module: 'experiences/kanban.js',
    tagName: 'monad-kanban'
  }
};
