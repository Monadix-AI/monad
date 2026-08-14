import type { WorkplaceExperienceDefinition } from '@monad/sdk-atom';

import { researchDeskApi } from './research-desk/api.ts';

export const researchDeskWorkplaceExperience: WorkplaceExperienceDefinition = {
  id: 'research-desk',
  title: 'Research',
  icon: 'search',
  api: { routes: researchDeskApi.routes.map(({ method, path }) => ({ method, path })) },
  entry: {
    type: 'web-component',
    module: 'dist/experiences/research-desk.js',
    tagName: 'monad-research-desk'
  }
};
