import type { WorkplaceExperienceDefinition } from '@monad/sdk-atom';

import { kanbanApi } from './kanban/api.ts';

export const kanbanWorkplaceExperience: WorkplaceExperienceDefinition = {
  id: 'kanban',
  title: 'Kanban',
  icon: 'git-fork',
  api: { routes: kanbanApi.routes.map(({ method, path }) => ({ method, path })) },
  entry: {
    type: 'web-component',
    module: 'dist/experiences/kanban.js',
    tagName: 'monad-kanban'
  }
};
