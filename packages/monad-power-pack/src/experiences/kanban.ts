import type { WorkspaceExperienceDefinition } from '@monad/sdk-atom';

import { kanbanApi } from './kanban/api.ts';

export const kanbanWorkspaceExperience: WorkspaceExperienceDefinition = {
  id: 'kanban',
  title: 'Kanban',
  icon: 'git-fork',
  api: { routes: kanbanApi.routes.map(({ method, path }) => ({ method, path })) },
  entry: {
    type: 'web-component',
    module: 'experiences/kanban.js',
    tagName: 'monad-kanban'
  }
};
