// Single chokepoint between the workspace shell and the live monad backend.
// Experience-specific transcript, rail, and composer projections live in atoms.

import type {
  InvitableMeshAgent,
  MeshSessionView,
  ProfileView,
  ProjectId,
  Session,
  SessionId,
  UIItem,
  UIMessageOutlineItem,
  WorkplaceProject
} from '@monad/protocol';

import { useProjectExperienceProjection } from '@monad/atoms/workplace-experiences';
import {
  atomPackSelectors,
  meshSessionSelectors,
  profileSelectors,
  projectSessionSelectors,
  sessionMemberSelectors,
  useDeleteSessionMutation,
  useGetAppearanceQuery,
  useGetProfileSettingsQuery,
  useListAtomPacksQuery,
  useListInvitableMeshAgentsQuery,
  useListMeshSessionsQuery,
  useListProfilesQuery,
  useListProjectSessionsQuery,
  useListSessionMembersQuery,
  useListWorkplaceProjectsQuery,
  useStreamMeshAgentStateQuery,
  useStreamUiItemsQuery,
  useUpdateSessionMutation,
  workplaceProjectAdapter,
  workplaceProjectSelectors
} from '@monad/client-rtk';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { installedChannelOptions } from '#/features/studio/channels-settings/installed-channel-options';
import { deriveProjectRouteSessionState } from '#/features/workspace/project-route-session-state';
import { useAcpAgentSettings } from '#/hooks/use-acp-agent-settings';
import { useMeshAgentSettings } from '#/hooks/use-mesh-agent-settings';
import { useTranscriptHistory } from '#/hooks/use-transcript-history';
import { normalizedComposerSettings } from '#/lib/composer-settings';
import { getWorkplaceProjectName } from '#/lib/workspace-sessions';
import { isChatExperienceReady } from './chat-experience-readiness';
import { DEV_SYSTEM_MESSAGES_IN_STREAM_ENABLED, useProjectDebugStore } from './debug/project-debug-store';
import { useWorkspaceProjectExperienceRuntime } from './experiences/project-experience-adapter';
import { useProjectActions } from './use-project-actions';

const EMPTY_PROFILES: ProfileView[] = [];
const EMPTY_ITEMS: UIItem[] = [];
const EMPTY_MESSAGE_OUTLINE: UIMessageOutlineItem[] = [];
const EMPTY_MESH_SESSIONS: MeshSessionView[] = [];
const EMPTY_INVITABLE_MESH_AGENTS: InvitableMeshAgent[] = [];

export function useProject(
  projectId: string,
  opts: {
    openAgentCard?: (memberId: string) => void;
    routedSessionId?: SessionId | null;
    switchExperience?: (id: string) => void;
  } = {}
) {
  // --- projects ---
  const { data: projectData, isLoading: projectsLoading } = useListWorkplaceProjectsQuery(undefined);
  const { data: userProfile } = useGetProfileSettingsQuery();
  const { data: appearance } = useGetAppearanceQuery();
  const composerSettings = normalizedComposerSettings(appearance?.composer);
  const { data: profileData } = useListProfilesQuery(undefined);
  const workplaceProjects: WorkplaceProject[] = useMemo(
    () => workplaceProjectSelectors.selectAll(projectData?.projects ?? workplaceProjectAdapter.getInitialState()),
    [projectData]
  );
  const modelProfiles = useMemo(
    () => (profileData ? profileSelectors.selectAll(profileData.profiles) : EMPTY_PROFILES),
    [profileData]
  );
  const currentProject = useMemo(
    () => workplaceProjects.find((project) => project.id === projectId) ?? null,
    [projectId, workplaceProjects]
  );
  const activeProjectId = currentProject?.id ?? null;

  // --- project session resolution (Track B: a project's own id is no longer a conversation id) ---
  // Project sessions are explicit. Opening a project with no sessions leaves the active session empty
  // instead of silently creating a project-name session.
  const projectSessionsQuery = useListProjectSessionsQuery(
    { projectId: activeProjectId ?? ('prj_' as ProjectId) },
    { skip: activeProjectId === null }
  );
  const projectSessionData = projectSessionsQuery.data;
  const projectSessions: Session[] = useMemo(
    () => (projectSessionData ? projectSessionSelectors.selectAll(projectSessionData.sessions) : []),
    [projectSessionData]
  );
  const [deleteSession] = useDeleteSessionMutation();
  const [updateSession] = useUpdateSessionMutation();
  // Manual pick (tab click) wins over the default; forgotten when the project changes so a fresh
  // project always starts on its own default rather than a stale sibling's manual selection.
  const [sessionOverride, setSessionOverride] = useState<SessionId | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeProjectId is the reset trigger, not a read value.
  useEffect(() => {
    setSessionOverride(null);
  }, [activeProjectId]);
  const defaultSessionId: SessionId | null = useMemo(() => {
    const activeSessions = projectSessions.filter((session) => !session.archived);
    if (activeSessions.length === 0) return null;
    return [...activeSessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id ?? null;
  }, [projectSessions]);
  const preferredSessionId =
    sessionOverride && projectSessions.some((session) => session.id === sessionOverride && !session.archived)
      ? sessionOverride
      : defaultSessionId;
  const activeSessionId = deriveProjectRouteSessionState(
    { activeSessionId: preferredSessionId, projectSessions },
    opts.routedSessionId ?? null
  ).activeSessionId;

  const switchSession = useMemo(() => (id: SessionId) => setSessionOverride(id), []);
  const closeSession = useMemo(
    () => async (id: SessionId) => {
      await deleteSession(id).unwrap();
      if (sessionOverride === id) setSessionOverride(null);
    },
    [deleteSession, sessionOverride]
  );
  const renameSession = useCallback(
    async (id: SessionId, title: string) => {
      await updateSession({ id, title }).unwrap();
    },
    [updateSession]
  );

  // --- live stream + lazy older history ---
  const stream = useStreamUiItemsQuery(activeSessionId ?? ('ses_' as SessionId), { skip: activeSessionId === null });
  const streamData = activeSessionId ? stream.currentData : undefined;
  const meshStateStream = useStreamMeshAgentStateQuery(activeSessionId ?? ('ses_' as SessionId), {
    skip: activeSessionId === null
  });
  const meshAgentState = activeSessionId ? meshStateStream.currentData : undefined;
  const meshSessionsQ = useListMeshSessionsQuery(activeSessionId ?? ('ses_' as SessionId), {
    skip: activeSessionId === null
  });
  const meshSessionsData = activeSessionId ? meshSessionsQ.currentData : undefined;
  const sessionMembersQ = useListSessionMembersQuery(activeSessionId ?? ('ses_' as SessionId), {
    skip: activeSessionId === null
  });
  const sessionMembersData = activeSessionId ? sessionMembersQ.currentData : undefined;
  const sessionMembers = useMemo(
    () => (sessionMembersData ? sessionMemberSelectors.selectAll(sessionMembersData) : []),
    [sessionMembersData]
  );
  const transcript = useTranscriptHistory({
    sessionId: activeSessionId,
    streamOldestCursor: streamData?.oldestCursor,
    streamHasMore: streamData?.hasMore ?? false,
    streamReplacementRevision: streamData?.replacementRevision,
    streamCanonicalMessageChanges: streamData?.canonicalMessageChanges,
    streamCanonicalMessageDroppedRevision: streamData?.canonicalMessageDroppedRevision,
    liveItems: streamData?.items ?? EMPTY_ITEMS
  });

  const acp = useAcpAgentSettings();
  const meshAgent = useMeshAgentSettings();
  const invitableMeshAgentsQ = useListInvitableMeshAgentsQuery(undefined);
  const invitableMeshAgents = invitableMeshAgentsQ.data ?? EMPTY_INVITABLE_MESH_AGENTS;
  const refreshMeshAgentCatalog = useCallback(() => {
    acp.refetch();
    meshAgent.refetch();
  }, [acp.refetch, meshAgent.refetch]);
  const membersLoading = projectsLoading || acp.loading || meshAgent.loading || invitableMeshAgentsQ.isLoading;
  const membersRefreshing = acp.refreshing || meshAgent.refreshing || invitableMeshAgentsQ.isFetching;
  const meshSessions = useMemo(
    () => (meshSessionsData ? meshSessionSelectors.selectAll(meshSessionsData) : EMPTY_MESH_SESSIONS),
    [meshSessionsData]
  );
  const projection = useProjectExperienceProjection({
    acpAgents: acp.agents,
    activeProjectId,
    activeSessionId,
    appearanceAvatarStyle: appearance?.avatarStyle,
    currentProject,
    liveItems: streamData?.items ?? EMPTY_ITEMS,
    meshAgents: invitableMeshAgents,
    meshAgentState,
    meshSessions,
    projectId,
    projectName: getWorkplaceProjectName,
    sessionMembers,
    userAvatarDataUrl: userProfile?.avatarDataUrl ?? undefined,
    userDisplayName: userProfile?.displayName,
    workplaceProjects
  });
  // Channel brand marks for message-origin badges: only the host can read installed atom packs, so
  // it resolves them once and hands the map to the experience.
  const atomPacksQuery = useListAtomPacksQuery();
  const channelIcons = useMemo(() => {
    if (!atomPacksQuery.data) return undefined;
    const options = installedChannelOptions(
      atomPackSelectors.selectAll(atomPacksQuery.data.atomPacks),
      atomPacksQuery.data.conflicts
    );
    return new Map(options.flatMap((option) => (option.icon ? [[option.type, option.icon] as const] : [])));
  }, [atomPacksQuery.data]);
  const {
    approvals,
    availableProjectMembers,
    human,
    liveItems,
    liveTools,
    meshAgentAvatarSeeds,
    meshAgentDisplayNames,
    meshAgentIcons,
    meshAgentTags,
    participants,
    projectParticipants,
    projectMembers,
    experienceProjectMembers,
    projects
  } = projection;
  const showDevSystemMessagesInStream = useProjectDebugStore((state) => state.showDevSystemMessagesInStream);
  const chatExperienceReady = isChatExperienceReady({
    activeProjectId,
    activeSessionId,
    projectSessionsLoading: projectSessionsQuery.isLoading,
    streamLoading: stream.isLoading,
    streamSnapshotReceived: streamData?.snapshotReceived,
    meshStateSubscribed: activeSessionId !== null,
    meshStateSnapshotReceived: meshAgentState?.snapshotReceived
  });

  const loadOlder = transcript.loadOlder;
  const loadNewer = transcript.loadNewer;
  const jumpToLive = transcript.jumpToLive;

  const {
    sendDirective,
    resolveApproval,
    answerQuestion,
    pauseAll,
    deleteProject,
    addProjectMember,
    removeProjectMember,
    updateProjectMemberSettings,
    updateProjectMemberIdentity,
    sendMeshAgentInput,
    stopMeshAgent
  } = useProjectActions({
    activeProjectId,
    activeSessionId,
    currentProject,
    projectMembers,
    approvals,
    acpAgents: acp.agents,
    meshAgents: invitableMeshAgents,
    avatarStyle: appearance?.avatarStyle
  });

  const controller = useMemo(
    () => ({
      projectId,
      activeProjectId,
      activeSessionId,
      projectSessions,
      ready: chatExperienceReady,
      // live collections
      projects,
      participants,
      projectParticipants,
      projectMembers,
      sessionMembers,
      membersLoading,
      membersRefreshing,
      availableProjectMembers,
      approvals,
      loadOlder,
      loadNewer,
      jumpToLive,
      transcriptMode: transcript.mode,
      messageOutline: streamData?.messageOutline ?? EMPTY_MESSAGE_OUTLINE,
      openAtMessage: transcript.openAtMessage,
      replyTargets: transcript.replyTargets,
      modelProfiles,
      sendShortcut: composerSettings.sendShortcut,
      source: {
        project: currentProject,
        transcriptItems: transcript.items,
        liveItems,
        liveTools,
        meshAgentState,
        meshSessions,
        human,
        avatarStyle: appearance?.avatarStyle,
        meshAgentAvatarSeeds,
        meshAgentTags,
        meshAgentDisplayNames,
        meshAgentIcons,
        channelIcons,
        showDeveloperOnlyMessages: DEV_SYSTEM_MESSAGES_IN_STREAM_ENABLED && showDevSystemMessagesInStream
      },
      workdir: { path: currentProject?.cwd },
      paused: false,
      // actions
      sendDirective,
      resolveApproval,
      answerQuestion,
      pauseAll,
      deleteProject,
      addProjectMember,
      removeProjectMember,
      updateProjectMemberSettings,
      updateProjectMemberIdentity,
      sendMeshAgentInput,
      stopMeshAgent,
      refreshMeshAgentCatalog,
      switchSession,
      closeSession,
      renameSession
    }),
    [
      activeProjectId,
      activeSessionId,
      chatExperienceReady,
      projectSessions,
      switchSession,
      closeSession,
      renameSession,
      projectId,
      projects,
      participants,
      projectParticipants,
      projectMembers,
      sessionMembers,
      membersLoading,
      membersRefreshing,
      availableProjectMembers,
      approvals,
      loadOlder,
      loadNewer,
      jumpToLive,
      transcript.mode,
      streamData?.messageOutline,
      transcript.openAtMessage,
      transcript.replyTargets,
      modelProfiles,
      composerSettings.sendShortcut,
      currentProject,
      transcript.items,
      liveItems,
      liveTools,
      meshAgentState,
      meshSessions,
      human,
      appearance?.avatarStyle,
      meshAgentAvatarSeeds,
      meshAgentTags,
      meshAgentDisplayNames,
      meshAgentIcons,
      channelIcons,
      showDevSystemMessagesInStream,
      currentProject?.cwd,
      sendDirective,
      resolveApproval,
      answerQuestion,
      pauseAll,
      deleteProject,
      addProjectMember,
      removeProjectMember,
      updateProjectMemberSettings,
      updateProjectMemberIdentity,
      sendMeshAgentInput,
      stopMeshAgent,
      refreshMeshAgentCatalog
    ]
  );
  const experienceController = useMemo(
    () => ({ ...controller, projectMembers: experienceProjectMembers }),
    [controller, experienceProjectMembers]
  );
  const experienceRuntime = useWorkspaceProjectExperienceRuntime(experienceController, opts);

  return useMemo(() => {
    return {
      ...controller,
      experienceRuntime
    };
  }, [controller, experienceRuntime]);
}

export type ProjectController = ReturnType<typeof useProject>;
