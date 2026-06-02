import type { WorkplaceExperienceDefinition } from '@monad/protocol';
import type { ProjectExperienceDefinition } from './types';

import { createElement } from 'react';

import { WorkplaceExperienceRenderer } from './WorkplaceExperienceRenderer';

function toProjectExperienceDefinition(atom: WorkplaceExperienceDefinition): ProjectExperienceDefinition {
  return {
    id: atom.id,
    label: atom.title,
    icon: atom.icon,
    render: (view) => createElement(WorkplaceExperienceRenderer, { atom, view })
  };
}

export function toProjectExperienceDefinitions(
  atoms: WorkplaceExperienceDefinition[] = []
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
