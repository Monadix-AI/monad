import type { ProjectController } from '../use-project';
import type { ProjectExperienceRuntime } from './types';

import { toChatRoomCanvas } from './chat-room/canvas';
import { toGraphicViewCanvas } from './graphic-view/canvas';

export function toExperienceRuntime(
  c: ProjectController,
  opts: {
    followNativeCliSession?: (id: string) => void;
    openAgentCard?: (id: string) => void;
    switchExperience: (id: string) => void;
  }
): ProjectExperienceRuntime {
  const chatRoomCanvas = toChatRoomCanvas(c, {
    followNativeCliSession: opts.followNativeCliSession,
    openAgentCard: opts.openAgentCard
  });
  const graphicViewCanvas = toGraphicViewCanvas(c);
  const host = {
    projectId: c.projectId,
    activeProjectId: c.activeProjectId,
    projects: c.projects,
    railAgents: c.railAgents,
    projectMembers: c.projectMembers,
    availableProjectMembers: c.availableProjectMembers,
    contextUsage: c.contextUsage,
    modelProfiles: c.modelProfiles,
    approvals: c.approvals,
    workdir: c.workdir,
    paused: c.paused,
    mentionTargets: c.mentionTargets
  };
  return {
    chatRoom: { canvas: chatRoomCanvas },
    graphicView: { canvas: graphicViewCanvas },
    host,
    snapshot: host,
    actions: {
      loadOlder: c.loadOlder,
      sendDirective: c.sendDirective,
      resolveApproval: c.resolveApproval,
      pauseAll: c.pauseAll,
      addProjectMember: c.addProjectMember,
      removeProjectMember: c.removeProjectMember,
      updateProjectMemberSettings: c.updateProjectMemberSettings,
      sendNativeCliInput: c.sendNativeCliInput,
      stopNativeCli: c.stopNativeCli,
      switchExperience: opts.switchExperience
    }
  };
}
