import type { ProfileView, ProjectId } from '@monad/protocol';
import type { ChatRoomExperienceRuntime } from './chat-room/runtime.ts';
import type { GraphicViewExperienceRuntime } from './graph-view/runtime.ts';
import type {
  AddProjectMemberOptions,
  ProjectMember,
  ProjectMemberCandidate,
  ProjectMemberSettings,
  ProjectMemberType
} from './project/project-members.ts';
import type { ProjectExperienceCanvasSource } from './project/source.ts';
import type { Project } from './project/types.ts';

import { createChatRoomExperienceRuntime } from './chat-room/runtime.ts';
import { createGraphicViewExperienceRuntime } from './graph-view/runtime.ts';

export interface ProjectWorkdirController {
  path?: string;
  set: (path: string) => Promise<void>;
}

export interface ProjectExperienceSnapshot {
  projectId: string;
  activeProjectId: ProjectId | null;
  projects: Project[];
  projectMembers: ProjectMember[];
  availableProjectMembers: ProjectMemberCandidate[];
  modelProfiles: ProfileView[];
  workdir: ProjectWorkdirController;
  paused: boolean;
}

export interface ProjectExperienceActions {
  loadOlder: () => void;
  sendDirective: (text: string) => Promise<void> | void;
  resolveApproval: (requestId: string, decision: 'approve' | 'reject') => void;
  pauseAll: () => void;
  addProjectMember: (type: ProjectMemberType, name: string, options?: AddProjectMemberOptions) => Promise<void>;
  removeProjectMember: (id: string) => Promise<void>;
  updateProjectMemberSettings: (id: string, patch: ProjectMemberSettings) => Promise<void>;
  sendNativeCliInput: (id: string, input: string) => Promise<void>;
  stopNativeCli: (id: string) => Promise<void>;
  switchExperience: (id: string) => void;
}

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
    paused: source.paused
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
