import type { ProjectController } from '../use-project';
import type { ProjectExperienceRuntime } from './types';

export function toExperienceRuntime(
  c: ProjectController,
  opts: {
    followNativeCliSession?: (id: string) => void;
    openAgentCard?: (id: string) => void;
    switchExperience: (id: string) => void;
  }
): ProjectExperienceRuntime {
  return {
    snapshot: {
      projectId: c.projectId,
      sessionId: c.sessionId,
      ready: c.ready,
      projects: c.projects,
      participants: c.participants,
      railAgents: c.railAgents,
      projectMembers: c.projectMembers,
      availableProjectMembers: c.availableProjectMembers,
      messages: c.messages,
      firstItemIndex: c.firstItemIndex,
      loadOlder: c.loadOlder,
      followNativeCliSession: opts.followNativeCliSession,
      openAgentCard: opts.openAgentCard,
      typing: c.typing,
      activity: c.activity,
      nativeCliStreams: c.nativeCliStreams,
      tasks: c.tasks,
      contextUsage: c.contextUsage,
      modelProfiles: c.modelProfiles,
      approvals: c.approvals,
      moderator: c.moderator,
      workdir: c.workdir,
      paused: c.paused,
      mentionTargets: c.mentionTargets,
      sendNativeCliInput: c.sendNativeCliInput,
      stopNativeCli: c.stopNativeCli
    },
    actions: {
      loadOlder: c.loadOlder,
      sendDirective: c.sendDirective,
      resolveApproval: c.resolveApproval,
      approveAll: c.approveAll,
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
