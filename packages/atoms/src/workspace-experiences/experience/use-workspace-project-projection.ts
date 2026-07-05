import type {
  AcpAgentView,
  AvatarStyle,
  NativeCliAgentView,
  NativeCliSessionView,
  ProjectId,
  UIItem,
  WorkplaceProject
} from '@monad/protocol';
import type { ProjectMember } from './project-members.ts';
import type { ApprovalView, Participant, Project } from './types.ts';

import { workplaceProjectMembersExtKey } from '@monad/protocol';
import { useMemo } from 'react';

import { parseProjectMembers } from './project-members.ts';
import {
  activeNativeCliAgentNames,
  humanParticipant,
  nativeCliStreamingAgentNames,
  projectApprovalViews,
  projectList,
  projectMemberCandidates,
  projectNativeCliMetadataMaps,
  projectParticipants,
  runningDelegationAgentNames,
  toolItems
} from './project-projection.ts';
import { useNativeCliActivityOverrides } from './use-native-cli-activity-overrides.ts';

export interface WorkspaceProjectProjection {
  approvals: ApprovalView[];
  availableProjectMembers: ReturnType<typeof projectMemberCandidates>;
  human: Participant;
  liveItems: readonly UIItem[];
  liveTools: Extract<UIItem, { kind: 'tool' }>[];
  nativeCliAvatarSeeds: Map<string, string>;
  nativeCliDisplayNames: Map<string, string>;
  nativeCliIcons: Map<string, Participant['icon']>;
  nativeCliTags: Map<string, string>;
  participants: Participant[];
  projectParticipants: Participant[];
  projectMembers: ProjectMember[];
  projects: Project[];
}

export function useWorkspaceProjectProjection(args: {
  acpAgents: readonly AcpAgentView[];
  activeProjectId: ProjectId | null;
  appearanceAvatarStyle?: AvatarStyle;
  currentProject: WorkplaceProject | null;
  liveItems: readonly UIItem[] | undefined;
  nativeCliAgents: readonly NativeCliAgentView[];
  nativeCliSessions: NativeCliSessionView[];
  projectId: string;
  projectName: (project: WorkplaceProject) => string;
  userAvatarDataUrl?: string;
  userDisplayName?: string;
  workplaceProjects: readonly WorkplaceProject[];
}): WorkspaceProjectProjection {
  const projectMembers = useMemo(
    () => parseProjectMembers(args.currentProject?.origin?.ext?.[workplaceProjectMembersExtKey]),
    [args.currentProject?.origin?.ext]
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
  const nativeCliMetadata = useMemo(
    () =>
      projectNativeCliMetadataMaps({
        nativeCliAgents: args.nativeCliAgents,
        projectId: args.currentProject?.id ?? args.projectId,
        projectMembers
      }),
    [args.currentProject?.id, args.nativeCliAgents, args.projectId, projectMembers]
  );
  const liveItems = args.liveItems ?? [];
  const liveTools = useMemo(() => toolItems(liveItems), [liveItems]);
  const nativeCliActivityOverrides = useNativeCliActivityOverrides(liveTools);
  const streamingNativeCliAgentNames = useMemo(() => nativeCliStreamingAgentNames(liveItems), [liveItems]);
  const activeAgentNames = useMemo(
    () =>
      activeNativeCliAgentNames({
        activityOverrideAgentNames: Object.keys(nativeCliActivityOverrides),
        nativeCliSessions: args.nativeCliSessions,
        streamingAgentNames: streamingNativeCliAgentNames
      }),
    [nativeCliActivityOverrides, args.nativeCliSessions, streamingNativeCliAgentNames]
  );
  const runningDelegations = useMemo(() => runningDelegationAgentNames(liveTools), [liveTools]);
  const participants = useMemo(
    () =>
      projectParticipants({
        acpAgents: args.acpAgents,
        activeNativeCliAgentNames: activeAgentNames,
        avatarStyle: args.appearanceAvatarStyle,
        liveTools,
        monadStreaming: liveItems.some(
          (item) =>
            item.kind === 'message' &&
            item.status === 'streaming' &&
            item.role === 'assistant' &&
            (item.agentName === undefined || item.agentName === 'monad') &&
            item.source !== 'managed-native-cli'
        ),
        nativeCliActivityOverrides,
        nativeCliAgents: args.nativeCliAgents,
        nativeCliAvatarSeeds: nativeCliMetadata.avatarSeeds,
        nativeCliSessions: args.nativeCliSessions,
        projectMembers,
        runningDelegations
      }),
    [
      args.acpAgents,
      activeAgentNames,
      args.appearanceAvatarStyle,
      liveTools,
      liveItems,
      nativeCliActivityOverrides,
      args.nativeCliAgents,
      nativeCliMetadata.avatarSeeds,
      args.nativeCliSessions,
      projectMembers,
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
        nativeCliAgents: args.nativeCliAgents,
        projectMembers
      }),
    [args.acpAgents, args.nativeCliAgents, projectMembers]
  );

  return {
    approvals,
    availableProjectMembers,
    human,
    liveItems,
    liveTools,
    nativeCliAvatarSeeds: nativeCliMetadata.avatarSeeds,
    nativeCliDisplayNames: nativeCliMetadata.displayNames,
    nativeCliIcons: nativeCliMetadata.icons,
    nativeCliTags: nativeCliMetadata.tags,
    participants,
    projectParticipants: participants.filter((participant) => participant.kind === 'agent'),
    projectMembers,
    projects
  };
}
