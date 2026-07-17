import type {
  AcpAgentView,
  AvatarStyle,
  ExternalAgentSessionView,
  ExternalAgentView,
  ProjectId,
  UIItem,
  WorkplaceProject,
  WorkplaceProjectSessionMember
} from '@monad/protocol';
import type { ProjectMember } from './project-members.ts';
import type { ApprovalView, Participant, Project } from './types.ts';

import { useMemo } from 'react';

import { parseProjectMembers, resolveExperienceProjectMembers } from './project-members.ts';
import {
  activeExternalAgentNames,
  externalAgentStreamingAgentNames,
  humanParticipant,
  projectApprovalViews,
  projectExternalAgentMetadataMaps,
  projectList,
  projectMemberCandidates,
  projectParticipants,
  runningDelegationAgentNames,
  toolItems
} from './project-projection.ts';
import { useExternalAgentActivityOverrides } from './use-external-agent-activity-overrides.ts';

export interface WorkspaceProjectProjection {
  approvals: ApprovalView[];
  availableProjectMembers: ReturnType<typeof projectMemberCandidates>;
  human: Participant;
  liveItems: readonly UIItem[];
  liveTools: Extract<UIItem, { kind: 'tool' }>[];
  externalAgentAvatarSeeds: Map<string, string>;
  externalAgentDisplayNames: Map<string, string>;
  externalAgentIcons: Map<string, Participant['icon']>;
  externalAgentTags: Map<string, string>;
  participants: Participant[];
  projectParticipants: Participant[];
  projectMembers: ProjectMember[];
  experienceProjectMembers: ProjectMember[];
  projects: Project[];
}

export function useWorkspaceProjectProjection(args: {
  acpAgents: readonly AcpAgentView[];
  activeProjectId: ProjectId | null;
  activeSessionId: string | null;
  appearanceAvatarStyle?: AvatarStyle;
  currentProject: WorkplaceProject | null;
  liveItems: readonly UIItem[] | undefined;
  externalAgents: readonly ExternalAgentView[];
  externalAgentSessions: ExternalAgentSessionView[];
  projectId: string;
  projectName: (project: WorkplaceProject) => string;
  userAvatarDataUrl?: string;
  userDisplayName?: string;
  sessionMembers: readonly WorkplaceProjectSessionMember[];
  workplaceProjects: readonly WorkplaceProject[];
}): WorkspaceProjectProjection {
  const projectMembers = useMemo(
    () => parseProjectMembers(args.currentProject?.memberTemplates ?? []),
    [args.currentProject?.memberTemplates]
  );
  const experienceProjectMembers = useMemo(
    () =>
      resolveExperienceProjectMembers({
        activeSessionId: args.activeSessionId,
        memberTemplates: args.currentProject?.memberTemplates ?? [],
        sessionMembers: args.sessionMembers
      }),
    [args.activeSessionId, args.currentProject?.memberTemplates, args.sessionMembers]
  );
  const human = useMemo(
    () =>
      humanParticipant({
        avatarDataUrl: args.userAvatarDataUrl,
        avatarStyle: args.appearanceAvatarStyle,
        displayName: args.userDisplayName
      }),
    [args.appearanceAvatarStyle, args.userAvatarDataUrl, args.userDisplayName]
  );
  const externalAgentMetadata = useMemo(
    () =>
      projectExternalAgentMetadataMaps({
        externalAgents: args.externalAgents,
        projectId: args.currentProject?.id ?? args.projectId,
        projectMembers: experienceProjectMembers
      }),
    [args.currentProject?.id, args.externalAgents, args.projectId, experienceProjectMembers]
  );
  const liveItems = args.liveItems ?? [];
  const liveTools = useMemo(() => toolItems(liveItems), [liveItems]);
  const externalAgentActivityOverrides = useExternalAgentActivityOverrides(liveTools);
  const streamingExternalAgentNames = useMemo(() => externalAgentStreamingAgentNames(liveItems), [liveItems]);
  const activeAgentNames = useMemo(
    () =>
      activeExternalAgentNames({
        activityOverrideAgentNames: Object.keys(externalAgentActivityOverrides),
        liveTools,
        externalAgentSessions: args.externalAgentSessions,
        streamingAgentNames: streamingExternalAgentNames
      }),
    [liveTools, externalAgentActivityOverrides, args.externalAgentSessions, streamingExternalAgentNames]
  );
  const runningDelegations = useMemo(() => runningDelegationAgentNames(liveTools), [liveTools]);
  const participants = useMemo(
    () =>
      projectParticipants({
        acpAgents: args.acpAgents,
        activeExternalAgentNames: activeAgentNames,
        avatarStyle: args.appearanceAvatarStyle,
        liveTools,
        monadStreaming: liveItems.some(
          (item) =>
            item.kind === 'message' &&
            item.status === 'streaming' &&
            item.role === 'assistant' &&
            (item.agentName === undefined || item.agentName === 'monad') &&
            item.source !== 'managed-external-agent'
        ),
        externalAgentActivityOverrides,
        externalAgents: args.externalAgents,
        externalAgentAvatarSeeds: externalAgentMetadata.avatarSeeds,
        externalAgentSessions: args.externalAgentSessions,
        projectMembers: experienceProjectMembers,
        runningDelegations
      }),
    [
      args.acpAgents,
      activeAgentNames,
      args.appearanceAvatarStyle,
      liveTools,
      liveItems,
      externalAgentActivityOverrides,
      args.externalAgents,
      externalAgentMetadata.avatarSeeds,
      args.externalAgentSessions,
      experienceProjectMembers,
      runningDelegations
    ]
  );
  const projects = useMemo(
    () => projectList(args.workplaceProjects, { activeProjectId: args.activeProjectId, projectName: args.projectName }),
    [args.activeProjectId, args.projectName, args.workplaceProjects]
  );
  const approvals = useMemo(() => projectApprovalViews(liveItems), [liveItems]);
  const availableProjectMembers = useMemo(
    () =>
      projectMemberCandidates({
        acpAgents: args.acpAgents,
        externalAgents: args.externalAgents,
        projectMembers
      }),
    [args.acpAgents, args.externalAgents, projectMembers]
  );

  return {
    approvals,
    availableProjectMembers,
    human,
    liveItems,
    liveTools,
    externalAgentAvatarSeeds: externalAgentMetadata.avatarSeeds,
    externalAgentDisplayNames: externalAgentMetadata.displayNames,
    externalAgentIcons: externalAgentMetadata.icons,
    externalAgentTags: externalAgentMetadata.tags,
    participants,
    projectParticipants: participants.filter((participant) => participant.kind === 'agent'),
    projectMembers,
    experienceProjectMembers,
    projects
  };
}
