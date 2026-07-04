import type {
  WorkspaceExperienceActions,
  WorkspaceExperienceSnapshot,
  WorkspaceExperienceWorkdir
} from '@monad/sdk-atom';
import type { ChatRoomExperienceRuntime } from './chat-room/runtime.ts';
import type { GraphicViewExperienceRuntime } from './graph-view/runtime.ts';
import type { AddProjectMemberOptions, ProjectMemberSettings, ProjectMemberType } from './project/project-members.ts';
import type { ProjectExperienceCanvasSource } from './project/source.ts';

import { createChatRoomExperienceRuntime } from './chat-room/runtime.ts';
import { createGraphicViewExperienceRuntime } from './graph-view/runtime.ts';

// Snapshot/actions are the published third-party contract, defined once in @monad/sdk-atom. These
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
  'graphic-view': GraphicViewExperienceRuntime;
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
  const graphicView = createGraphicViewExperienceRuntime(source);
  const snapshot: ProjectExperienceSnapshot = {
    projectId: source.projectId,
    activeProjectId: source.activeProjectId,
    projects: source.projects,
    projectMembers: source.projectMembers,
    availableProjectMembers: source.availableProjectMembers,
    modelProfiles: source.modelProfiles,
    workdir: source.workdir,
    paused: source.paused,
    // Stamp the activity-graph projection onto the published snapshot so a web-component experience
    // (the first-party graph-view) can render presence + activity from the host API alone — the
    // host-component path read it straight off `views['graphic-view']`, the web-component path can't.
    graphCanvas: graphicView.canvas
  };
  return {
    views: {
      'chat-room': chatRoom,
      'graphic-view': graphicView
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
      sendNativeCliInput: source.sendNativeCliInput,
      stopNativeCli: source.stopNativeCli,
      switchExperience: opts.switchExperience
    }
  };
}
