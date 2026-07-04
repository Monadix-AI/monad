import type { WorkspaceExperienceDefinition, WorkspaceExperienceEntry } from '@monad/protocol';
import type { ProjectExperienceDefinition } from './types';

import { createElement, lazy, Suspense } from 'react';

const WebComponentExperience = lazy(() =>
  import('./web-component/WebComponentExperience').then((module) => ({ default: module.WebComponentExperience }))
);
const BuiltinWorkspaceExperienceHost = lazy(() =>
  import('./builtin/BuiltinWorkspaceExperience').then((module) => ({ default: module.BuiltinWorkspaceExperienceHost }))
);

type BuiltinWorkspaceExperienceDefinition = WorkspaceExperienceDefinition & {
  entry: Extract<WorkspaceExperienceEntry, { type: 'builtin' }>;
};

type WebComponentWorkspaceExperienceDefinition = WorkspaceExperienceDefinition & {
  entry: Extract<WorkspaceExperienceEntry, { type: 'web-component' }>;
};

function toBuiltinExperience(atom: BuiltinWorkspaceExperienceDefinition): ProjectExperienceDefinition {
  return {
    id: atom.id,
    label: atom.title,
    icon: atom.icon,
    render: (view) =>
      createElement(
        Suspense,
        { fallback: null },
        createElement(BuiltinWorkspaceExperienceHost, { component: atom.entry.component, view })
      )
  };
}

export function toProjectExperienceDefinitions(
  atoms: WorkspaceExperienceDefinition[] = []
): ProjectExperienceDefinition[] {
  return atoms.map((atom) => {
    if (atom.entry.type === 'builtin') return toBuiltinExperience(atom as BuiltinWorkspaceExperienceDefinition);
    const webComponentAtom = atom as WebComponentWorkspaceExperienceDefinition;
    return {
      id: atom.id,
      label: atom.title,
      icon: atom.icon,
      render: (view) =>
        createElement(
          Suspense,
          { fallback: null },
          createElement(WebComponentExperience, { atom: webComponentAtom, view })
        )
    };
  });
}

export function listProjectExperiences(atoms: ProjectExperienceDefinition[] = []): ProjectExperienceDefinition[] {
  const seen = new Set<string>();
  return atoms.filter((experience) => {
    if (seen.has(experience.id)) return false;
    seen.add(experience.id);
    return true;
  });
}

export function getProjectExperience(
  id: string | undefined,
  experiences: ProjectExperienceDefinition[] = []
): ProjectExperienceDefinition | null {
  if (!id) return experiences[0] ?? null;
  return experiences.find((experience) => experience.id === id) ?? experiences[0] ?? null;
}
