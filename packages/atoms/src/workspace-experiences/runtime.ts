import type { ProfileView, ProjectId } from '@monad/protocol';
import type { ChatRoomCanvas, ChatRoomCanvasSource } from './chat-room/utils/canvas.ts';
import type { ProjectComposerSurface } from './chat-room/utils/composer.ts';
import type { WorkspaceExperienceGraphCanvas } from './graph-view/utils/graph-model.ts';
import type {
  AddProjectMemberOptions,
  ProjectMember,
  ProjectMemberCandidate,
  ProjectMemberSettings,
  ProjectMemberType
} from './project/project-members.ts';
import type { Project } from './project/types.ts';

import { toChatRoomCanvas } from './chat-room/utils/canvas.ts';
import { toProjectComposerSurface } from './chat-room/utils/composer.ts';
import { toGraphicViewCanvas } from './graph-view/utils/canvas.ts';

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

export interface ProjectExperienceRuntimeSource extends ProjectExperienceSnapshot, ChatRoomCanvasSource {
  addProjectMember: (type: ProjectMemberType, name: string, options?: AddProjectMemberOptions) => Promise<void>;
  removeProjectMember: (id: string) => Promise<void>;
  updateProjectMemberSettings: (id: string, patch: ProjectMemberSettings) => Promise<void>;
}

export interface ChatRoomExperienceRuntime {
  canvas: ChatRoomCanvas;
}

export interface GraphicViewExperienceRuntime {
  canvas: WorkspaceExperienceGraphCanvas;
}

export interface WorkspaceExperienceRuntimeViews {
  'chat-room': ChatRoomExperienceRuntime & { composer: ProjectComposerSurface };
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
  const chatRoomCanvas = toChatRoomCanvas(source, {
    openAgentCard: opts.openAgentCard
  });
  const graphicViewCanvas = toGraphicViewCanvas({
    participants: source.participants,
    liveTools: source.source.liveTools ?? []
  });
  const composer = toProjectComposerSurface(chatRoomCanvas, chatRoomCanvas.typing);
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
      'chat-room': { canvas: chatRoomCanvas, composer },
      'graphic-view': { canvas: graphicViewCanvas }
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
