import type { WorkspaceExperienceDefinition } from '@monad/protocol';
import type { ProjectExperienceDefinition } from './types';

import { createElement, lazy, Suspense } from 'react';

const ChatRoomExperienceView = lazy(() =>
  import('./chat-room/ChatRoomExperience').then((module) => ({ default: module.ChatRoomExperienceView }))
);
const GraphicViewExperienceView = lazy(() =>
  import('./graphic-view/GraphicViewExperience').then((module) => ({ default: module.GraphicViewExperienceView }))
);
const WebComponentExperience = lazy(() =>
  import('./web-component/WebComponentExperience').then((module) => ({ default: module.WebComponentExperience }))
);

const chatRoomExperience: ProjectExperienceDefinition = {
  id: 'chat-room',
  labelKey: 'web.workplace.experience.chat',
  icon: 'message-square',
  source: 'builtin',
  render: (view) => createElement(Suspense, { fallback: null }, createElement(ChatRoomExperienceView, view))
};

const graphicViewExperience: ProjectExperienceDefinition = {
  id: 'graphic-view',
  labelKey: 'web.workplace.experience.graph',
  icon: 'git-fork',
  source: 'builtin',
  render: (view) => createElement(Suspense, { fallback: null }, createElement(GraphicViewExperienceView, view))
};

const BUILTINS: ProjectExperienceDefinition[] = [chatRoomExperience, graphicViewExperience];

export function toProjectExperienceDefinitions(
  atoms: WorkspaceExperienceDefinition[] = []
): ProjectExperienceDefinition[] {
  return atoms.map((atom) => ({
    id: atom.id,
    label: atom.title,
    icon: atom.icon,
    source: 'atom',
    atomName: atom.id,
    atom,
    render: (view) => createElement(Suspense, { fallback: null }, createElement(WebComponentExperience, { atom, view }))
  }));
}

export function listProjectExperiences(atoms: ProjectExperienceDefinition[] = []): ProjectExperienceDefinition[] {
  const seen = new Set(BUILTINS.map((experience) => experience.id));
  return [
    ...BUILTINS,
    ...atoms.filter((experience) => {
      if (seen.has(experience.id)) return false;
      seen.add(experience.id);
      return true;
    })
  ];
}

export function getProjectExperience(
  id: string | undefined,
  experiences: ProjectExperienceDefinition[] = BUILTINS
): ProjectExperienceDefinition {
  if (id === 'chat') return chatRoomExperience;
  if (id === 'graph') return graphicViewExperience;
  return experiences.find((experience) => experience.id === id) ?? chatRoomExperience;
}
