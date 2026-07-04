import { expect, test } from 'bun:test';

import {
  getProjectExperience,
  listProjectExperiences,
  toProjectExperienceDefinitions
} from '../../features/workplace/experiences/registry.ts';

test('project experiences: built-in atom descriptors expose full runtime-switchable project experiences', () => {
  const experiences = listProjectExperiences(
    toProjectExperienceDefinitions([
      {
        id: 'primary-view',
        title: 'Primary',
        icon: 'message-square',
        entry: { type: 'host-component', component: 'primary-view' }
      },
      {
        id: 'secondary-view',
        title: 'Secondary',
        icon: 'git-fork',
        entry: { type: 'host-component', component: 'secondary-view' }
      }
    ])
  );

  expect(experiences.map((experience) => experience.id)).toEqual(['primary-view', 'secondary-view']);
  expect(getProjectExperience('secondary-view', experiences)?.id).toBe('secondary-view');
  expect(getProjectExperience('missing', experiences)?.id).toBe('primary-view');
});

test('project experiences: workspace-experience atoms join the runtime-switchable registry', () => {
  const atoms = toProjectExperienceDefinitions([
    {
      id: 'primary-view',
      title: 'Primary',
      icon: 'message-square',
      entry: { type: 'host-component', component: 'primary-view' }
    },
    {
      id: 'secondary-view',
      title: 'Secondary',
      icon: 'git-fork',
      entry: { type: 'host-component', component: 'secondary-view' }
    },
    {
      id: 'custom-canvas',
      title: 'Custom Canvas',
      entry: { type: 'web-component', module: '/atoms/packs/custom/canvas.js', tagName: 'custom-canvas' }
    }
  ]);
  const experiences = listProjectExperiences(atoms);

  expect(experiences.map((experience) => experience.id)).toEqual(['primary-view', 'secondary-view', 'custom-canvas']);
  expect(getProjectExperience('custom-canvas', experiences)).toMatchObject({
    id: 'custom-canvas',
    label: 'Custom Canvas'
  });
  expect(getProjectExperience('secondary-view', experiences)?.id).toBe('secondary-view');
  expect(getProjectExperience('missing', experiences)?.id).toBe('primary-view');
});
