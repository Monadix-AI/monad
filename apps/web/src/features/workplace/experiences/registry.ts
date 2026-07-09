import type { WorkspaceExperienceDefinition } from '@monad/protocol';
import type { ProjectExperienceDefinition } from './types';

import { createElement } from 'react';

import { WorkspaceExperienceRenderer } from './WorkspaceExperienceRenderer';

function toProjectExperienceDefinition(atom: WorkspaceExperienceDefinition): ProjectExperienceDefinition {
  return {
    id: atom.id,
    label: atom.title,
    icon: atom.icon,
    render: (view) => createElement(WorkspaceExperienceRenderer, { atom, view })
  };
}

export function toProjectExperienceDefinitions(
  atoms: WorkspaceExperienceDefinition[] = []
): ProjectExperienceDefinition[] {
  return atoms.map(toProjectExperienceDefinition);
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
