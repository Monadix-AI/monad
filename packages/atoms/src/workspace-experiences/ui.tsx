import type { ReactElement } from 'react';
import type { ProjectExperienceRuntime, ProjectExperienceRuntimeSource } from './runtime.ts';

import { createElement, lazy, useMemo } from 'react';

import { renderChatRoomWorkspaceExperience } from './chat-room/ui.tsx';
import {
  useWorkspaceProjectProjection as useProjection,
  type WorkspaceProjectProjection
} from './project/use-workspace-project-projection.ts';
import { createProjectExperienceRuntime as createRuntime } from './runtime.ts';

export type { ProjectExperienceRuntimeSource } from './runtime.ts';

type ProjectExperienceViewLike = {
  runtime: unknown;
};

const GraphViewWorkspaceExperience = lazy(() =>
  import('./graph-view/ui.tsx').then((module) => ({ default: module.GraphViewWorkspaceExperience }))
);

const builtinWorkspaceExperienceRenderers = {
  'chat-room': (runtime: ProjectExperienceRuntime) =>
    renderChatRoomWorkspaceExperience({ runtime: runtime.views['chat-room'] }),
  'graphic-view': (runtime: ProjectExperienceRuntime) =>
    createElement(GraphViewWorkspaceExperience, { runtime: runtime.views['graphic-view'] })
} satisfies Record<string, (runtime: ProjectExperienceRuntime) => ReactElement>;

export function renderBuiltinWorkspaceExperience(args: {
  component: string;
  view: ProjectExperienceViewLike;
}): ReactElement | null {
  const runtime = args.view.runtime as ProjectExperienceRuntime;
  const renderer =
    builtinWorkspaceExperienceRenderers[args.component as keyof typeof builtinWorkspaceExperienceRenderers];
  return renderer?.(runtime) ?? null;
}

function buildProjectExperienceRuntime(
  source: ProjectExperienceRuntimeSource,
  opts: {
    openAgentCard?: (id: string) => void;
    switchExperience: (id: string) => void;
  }
): ProjectExperienceRuntime {
  return createRuntime(source, opts);
}

export function useProjectExperienceProjection(args: Parameters<typeof useProjection>[0]): WorkspaceProjectProjection {
  return useProjection(args);
}

export function useProjectExperienceRuntime(
  source: ProjectExperienceRuntimeSource,
  opts: {
    openAgentCard?: (id: string) => void;
    switchExperience: (id: string) => void;
  }
): ProjectExperienceRuntime {
  return useMemo(() => buildProjectExperienceRuntime(source, opts), [source, opts]);
}
