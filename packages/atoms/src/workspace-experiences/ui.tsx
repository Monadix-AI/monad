import type { WorkspaceExperienceProjectDialogRequest } from '@monad/protocol';
import type { ReactElement } from 'react';
import type { ProjectExperienceRuntime, ProjectExperienceRuntimeSource } from './runtime.ts';

import { useMemo } from 'react';

import { configureChatRoomExperienceClients, renderChatRoomWorkspaceExperience } from './chat-room/ui.tsx';
import { renderGraphViewWorkspaceExperience } from './graph-view/ui.tsx';
import {
  useWorkspaceProjectProjection as useProjection,
  type WorkspaceProjectProjection
} from './project/use-workspace-project-projection.ts';
import { createProjectExperienceRuntime as createRuntime } from './runtime.ts';

export type { ProjectExperienceRuntimeSource } from './runtime.ts';

type ProjectExperienceViewLike = {
  runtime: unknown;
};

export interface BuiltinWorkspaceExperienceHostActions {
  nativeCliAgentsHref: string;
  requestProjectDialog: (request: WorkspaceExperienceProjectDialogRequest) => void;
  voiceModelState?: 'checking' | 'configured' | 'missing' | 'failed';
}

export type BuiltinWorkspaceExperienceClient = {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  openModelSettings?: () => void;
};

export function configureBuiltinWorkspaceExperienceClients(client: BuiltinWorkspaceExperienceClient): void {
  configureChatRoomExperienceClients(client);
}

const builtinWorkspaceExperienceRenderers = {
  'chat-room': (runtime: ProjectExperienceRuntime, host: BuiltinWorkspaceExperienceHostActions) =>
    renderChatRoomWorkspaceExperience({
      host,
      runtime: runtime.views['chat-room']
    }),
  'graphic-view': (runtime: ProjectExperienceRuntime) =>
    renderGraphViewWorkspaceExperience(runtime.views['graphic-view'])
} satisfies Record<
  string,
  (runtime: ProjectExperienceRuntime, host: BuiltinWorkspaceExperienceHostActions) => ReactElement
>;

export function renderBuiltinWorkspaceExperience(args: {
  component: string;
  host: BuiltinWorkspaceExperienceHostActions;
  view: ProjectExperienceViewLike;
}): ReactElement | null {
  const runtime = args.view.runtime as ProjectExperienceRuntime;
  const renderer =
    builtinWorkspaceExperienceRenderers[args.component as keyof typeof builtinWorkspaceExperienceRenderers];
  return renderer?.(runtime, args.host) ?? null;
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
