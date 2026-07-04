import { expect, test } from 'bun:test';
import { builtinWorkspaceExperiences } from '@monad/atoms/workspace-experiences';

import {
  getProjectExperience,
  listProjectExperiences,
  toProjectExperienceDefinitions
} from '../../features/workplace/experiences/registry.ts';

test('project experiences: built-in atom descriptors expose full runtime-switchable project experiences', () => {
  const experiences = listProjectExperiences(
    toProjectExperienceDefinitions([
      {
        id: 'chat-room',
        title: 'Chat',
        icon: 'message-square',
        entry: { type: 'builtin', component: 'chat-room' }
      },
      {
        id: 'graphic-view',
        title: 'Activity',
        icon: 'git-fork',
        entry: { type: 'builtin', component: 'graphic-view' }
      }
    ])
  );

  expect(experiences.map((experience) => experience.id)).toEqual(['chat-room', 'graphic-view']);
  expect(getProjectExperience('graphic-view', experiences)?.id).toBe('graphic-view');
  expect(getProjectExperience('missing', experiences)?.id).toBe('chat-room');
});

test('project experiences: built-ins are available before daemon registry data returns', () => {
  const experiences = listProjectExperiences(toProjectExperienceDefinitions([...builtinWorkspaceExperiences]));

  expect(experiences.map((experience) => experience.id)).toEqual(['chat-room', 'graphic-view']);
  expect(getProjectExperience('chat-room', experiences)?.id).toBe('chat-room');
});

test('project experiences: workspace-experience atoms join the runtime-switchable registry', () => {
  const atoms = toProjectExperienceDefinitions([
    {
      id: 'chat-room',
      title: 'Chat',
      icon: 'message-square',
      entry: { type: 'builtin', component: 'chat-room' }
    },
    {
      id: 'graphic-view',
      title: 'Activity',
      icon: 'git-fork',
      entry: { type: 'builtin', component: 'graphic-view' }
    },
    {
      id: 'custom-canvas',
      title: 'Custom Canvas',
      entry: { type: 'web-component', module: '/atoms/packs/custom/canvas.js', tagName: 'custom-canvas' }
    }
  ]);
  const experiences = listProjectExperiences(atoms);

  expect(experiences.map((experience) => experience.id)).toEqual(['chat-room', 'graphic-view', 'custom-canvas']);
  expect(getProjectExperience('custom-canvas', experiences)).toMatchObject({
    id: 'custom-canvas',
    label: 'Custom Canvas'
  });
  expect(getProjectExperience('graphic-view', experiences)?.id).toBe('graphic-view');
  expect(getProjectExperience('missing', experiences)?.id).toBe('chat-room');
});
