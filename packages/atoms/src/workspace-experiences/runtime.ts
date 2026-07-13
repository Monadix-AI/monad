import type {
  WorkspaceExperienceActions,
  WorkspaceExperienceSnapshot,
  WorkspaceExperienceWorkdir
} from '@monad/sdk-experience';
import type { ChatRoomExperienceRuntime } from './chat-room/runtime.ts';
import type {
  AddProjectMemberOptions,
  ProjectMemberSettings,
  ProjectMemberType
} from './experience/project-members.ts';
import type { ProjectExperienceCanvasSource } from './experience/source.ts';

import { createChatRoomExperienceRuntime } from './chat-room/runtime.ts';
import { toWorkspaceExperienceGraphCanvas } from './experience/activity-graph.ts';

// Snapshot/actions are the published third-party contract, defined once in @monad/sdk-experience. These
// aliases keep the atoms-internal names stable while sdk-atom owns the shape.
export type ProjectWorkdirController = WorkspaceExperienceWorkdir;
export type ProjectExperienceSnapshot = WorkspaceExperienceSnapshot;
export type ProjectExperienceActions = WorkspaceExperienceActions;

export interface ProjectExperienceRuntimeSource extends ProjectExperienceSnapshot, ProjectExperienceCanvasSource {
  addProjectMember: (type: ProjectMemberType, name: string, options?: AddProjectMemberOptions) => Promise<void>;
  removeProjectMember: (id: string) => Promise<void>;
  updateProjectMemberSettings: (id: string, patch: ProjectMemberSettings) => Promise<void>;
}

export interface WorkspaceExperienceRuntimeViews {
  'chat-room': ChatRoomExperienceRuntime;
}

export interface ProjectExperienceRuntime {
  views: WorkspaceExperienceRuntimeViews;
  snapshot: ProjectExperienceSnapshot;
  actions: ProjectExperienceActions;
}

export function createProjectExperienceRuntime(
  source: ProjectExperienceRuntimeSource,
  opts: {
    openAgentCard?: (id: string) => void;
    switchExperience: (id: string) => void;
  }
): ProjectExperienceRuntime {
  const chatRoom = createChatRoomExperienceRuntime(source, {
    openAgentCard: opts.openAgentCard
  });
  const snapshot: ProjectExperienceSnapshot = {
    projectId: source.projectId,
    activeProjectId: source.activeProjectId,
    activeSessionId: source.activeSessionId,
    projects: source.projects,
    projectMembers: source.projectMembers,
    availableProjectMembers: source.availableProjectMembers,
    modelProfiles: source.modelProfiles,
    workdir: source.workdir,
    paused: source.paused,
    // Published framework-neutral data. Optional experiences such as Power Pack's Kanban render it
    // without gaining access to the built-in React runtime.
    graphCanvas: toWorkspaceExperienceGraphCanvas({
      participants: source.participants,
      liveTools: source.source.liveTools ?? []
    })
  };
  return {
    views: {
      'chat-room': chatRoom
    },
    snapshot,
    actions: {
      loadOlder: source.loadOlder,
      sendDirective: source.sendDirective,
      resolveApproval: source.resolveApproval,
      pauseAll: source.pauseAll,
      addProjectMember: source.addProjectMember,
      removeProjectMember: source.removeProjectMember,
      updateProjectMemberSettings: source.updateProjectMemberSettings,
      sendExternalAgentInput: source.sendExternalAgentInput,
      stopExternalAgent: source.stopExternalAgent,
      switchExperience: opts.switchExperience
    }
  };
}
