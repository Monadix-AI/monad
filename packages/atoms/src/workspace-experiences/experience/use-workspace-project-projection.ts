import type {
  AcpAgentView,
  AvatarStyle,
  MeshAgentView,
  MeshSessionView,
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
  activeMeshAgentNames,
  humanParticipant,
  meshAgentStreamingAgentNames,
  projectApprovalViews,
  projectList,
  projectMemberCandidates,
  projectMeshAgentMetadataMaps,
  projectParticipants,
  runningDelegationAgentNames,
  toolItems
} from './project-projection.ts';
import { useMeshAgentActivityOverrides } from './use-mesh-agent-activity-overrides.ts';

export interface WorkspaceProjectProjection {
  approvals: ApprovalView[];
  availableProjectMembers: ReturnType<typeof projectMemberCandidates>;
  human: Participant;
  liveItems: readonly UIItem[];
  liveTools: Extract<UIItem, { kind: 'tool' }>[];
  meshAgentAvatarSeeds: Map<string, string>;
  meshAgentDisplayNames: Map<string, string>;
  meshAgentIcons: Map<string, Participant['icon']>;
  meshAgentTags: Map<string, string>;
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
  meshAgents: readonly MeshAgentView[];
  meshSessions: MeshSessionView[];
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
  const meshAgentMetadata = useMemo(
    () =>
      projectMeshAgentMetadataMaps({
        meshAgents: args.meshAgents,
        projectId: args.currentProject?.id ?? args.projectId,
        projectMembers: experienceProjectMembers
      }),
    [args.currentProject?.id, args.meshAgents, args.projectId, experienceProjectMembers]
  );
  const liveItems = args.liveItems ?? [];
  const liveTools = useMemo(() => toolItems(liveItems), [liveItems]);
  const meshAgentActivityOverrides = useMeshAgentActivityOverrides(liveTools);
  const streamingMeshAgentNames = useMemo(() => meshAgentStreamingAgentNames(liveItems), [liveItems]);
  const activeAgentNames = useMemo(
    () =>
      activeMeshAgentNames({
        activityOverrideAgentNames: Object.keys(meshAgentActivityOverrides),
        liveTools,
        meshSessions: args.meshSessions,
        streamingAgentNames: streamingMeshAgentNames
      }),
    [liveTools, meshAgentActivityOverrides, args.meshSessions, streamingMeshAgentNames]
  );
  const runningDelegations = useMemo(() => runningDelegationAgentNames(liveTools), [liveTools]);
  const participants = useMemo(
    () =>
      projectParticipants({
        acpAgents: args.acpAgents,
        activeMeshAgentNames: activeAgentNames,
        avatarStyle: args.appearanceAvatarStyle,
        liveTools,
        monadStreaming: liveItems.some(
          (item) =>
            item.kind === 'message' &&
            item.status === 'streaming' &&
            item.role === 'assistant' &&
            (item.agentName === undefined || item.agentName === 'monad') &&
            item.source !== 'managed-mesh-agent'
        ),
        meshAgentActivityOverrides,
        meshAgents: args.meshAgents,
        meshAgentAvatarSeeds: meshAgentMetadata.avatarSeeds,
        meshSessions: args.meshSessions,
        projectMembers: experienceProjectMembers,
        runningDelegations
      }),
    [
      args.acpAgents,
      activeAgentNames,
      args.appearanceAvatarStyle,
      liveTools,
      liveItems,
      meshAgentActivityOverrides,
      args.meshAgents,
      meshAgentMetadata.avatarSeeds,
      args.meshSessions,
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
        meshAgents: args.meshAgents,
        projectMembers
      }),
    [args.acpAgents, args.meshAgents, projectMembers]
  );

  return {
    approvals,
    availableProjectMembers,
    human,
    liveItems,
    liveTools,
    meshAgentAvatarSeeds: meshAgentMetadata.avatarSeeds,
    meshAgentDisplayNames: meshAgentMetadata.displayNames,
    meshAgentIcons: meshAgentMetadata.icons,
    meshAgentTags: meshAgentMetadata.tags,
    participants,
    projectParticipants: participants.filter((participant) => participant.kind === 'agent'),
    projectMembers,
    experienceProjectMembers,
    projects
  };
}
