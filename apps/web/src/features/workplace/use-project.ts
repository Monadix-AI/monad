// Single chokepoint between the workspace shell and the live monad backend.
// Experience-specific transcript, rail, and composer projections live in atoms.

import type {
  MeshSessionId,
  MeshSessionView,
  ProfileView,
  ProjectId,
  Session,
  SessionId,
  UIItem,
  WorkplaceProject
} from '@monad/protocol';

import { useProjectExperienceProjection } from '@monad/atoms/workspace-experiences';
import {
  meshSessionSelectors,
  profileSelectors,
  projectSessionSelectors,
  sessionMemberSelectors,
  useDeleteSessionMutation,
  useGetAppearanceQuery,
  useGetProfileSettingsQuery,
  useListMeshSessionsQuery,
  useListProfilesQuery,
  useListProjectSessionsQuery,
  useListSessionMembersQuery,
  useListWorkplaceProjectsQuery,
  useStreamUiItemsQuery,
  workplaceProjectAdapter,
  workplaceProjectSelectors
} from '@monad/client-rtk';
import { meshSessionIdSchema } from '@monad/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';

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
const EMPTY_MESH_SESSIONS: MeshSessionView[] = [];

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

  // --- live stream + lazy older history ---
  const stream = useStreamUiItemsQuery(activeSessionId ?? ('ses_' as SessionId), { skip: activeSessionId === null });
  const streamData = activeSessionId ? stream.currentData : undefined;
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
    streamReplacementRevision: streamData?.replacementRevision
  });

  const acp = useAcpAgentSettings();
  const meshAgent = useMeshAgentSettings();
  const membersLoading = projectsLoading || acp.loading || meshAgent.loading;
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
    meshAgents: meshAgent.agents,
    meshSessions,
    projectId,
    projectName: getWorkplaceProjectName,
    sessionMembers,
    userAvatarDataUrl: userProfile?.avatarDataUrl ?? undefined,
    userDisplayName: userProfile?.displayName,
    workplaceProjects
  });
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
    streamSnapshotReceived: streamData?.snapshotReceived
  });

  // The daemon starts a managed member's mesh-agent session server-side (join / first delivery),
  // so no client mutation ever fires to invalidate `listMeshSessions`'s RTK Query cache — the
  // join notice would otherwise only ever be backed by the bounded live-items window and vanish once a
  // long turn's events push the launch record out of it. Refetch the durable session list the moment a
  // new mesh-agent session id shows up live, so the REST-backed join view takes over before that
  // happens. Tracked in a ref (not state) so this never re-renders on its own.
  const refetchedMeshSessionIds = useRef(new Set<MeshSessionId>());
  const refetchMeshSessions = meshSessionsQ.refetch;
  const knownMeshSessionIds = useMemo(() => new Set(meshSessions.map((session) => session.id)), [meshSessions]);
  useEffect(() => {
    refetchedMeshSessionIds.current.clear();
  }, []);
  useEffect(() => {
    for (const tool of liveTools) {
      if (!tool.tool.startsWith('mesh-agent:')) continue;
      const parsedId = meshSessionIdSchema.safeParse(tool.id);
      if (!parsedId.success) continue;
      if (knownMeshSessionIds.has(parsedId.data)) continue;
      if (refetchedMeshSessionIds.current.has(parsedId.data)) continue;
      refetchedMeshSessionIds.current.add(parsedId.data);
      void refetchMeshSessions();
      return;
    }
  }, [liveTools, knownMeshSessionIds, refetchMeshSessions]);

  const loadOlder = transcript.loadOlder;

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
    stopMeshAgent,
    setWorkdir
  } = useProjectActions({
    activeProjectId,
    activeSessionId,
    currentProject,
    projectMembers,
    approvals,
    acpAgents: acp.agents,
    meshAgents: meshAgent.agents,
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
      membersLoading,
      availableProjectMembers,
      approvals,
      loadOlder,
      modelProfiles,
      sendShortcut: composerSettings.sendShortcut,
      followUpBehavior: composerSettings.followUpBehavior,
      source: {
        project: currentProject,
        transcriptItems: transcript.items,
        liveItems,
        liveTools,
        meshSessions,
        human,
        avatarStyle: appearance?.avatarStyle,
        meshAgentAvatarSeeds,
        meshAgentTags,
        meshAgentDisplayNames,
        meshAgentIcons,
        showDeveloperOnlyMessages: DEV_SYSTEM_MESSAGES_IN_STREAM_ENABLED && showDevSystemMessagesInStream
      },
      workdir: { path: currentProject?.cwd, set: setWorkdir },
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
      switchSession,
      closeSession
    }),
    [
      activeProjectId,
      activeSessionId,
      chatExperienceReady,
      projectSessions,
      switchSession,
      closeSession,
      projectId,
      projects,
      participants,
      projectParticipants,
      projectMembers,
      membersLoading,
      availableProjectMembers,
      approvals,
      loadOlder,
      modelProfiles,
      composerSettings.sendShortcut,
      composerSettings.followUpBehavior,
      currentProject,
      transcript.items,
      liveItems,
      liveTools,
      meshSessions,
      human,
      appearance?.avatarStyle,
      meshAgentAvatarSeeds,
      meshAgentTags,
      meshAgentDisplayNames,
      meshAgentIcons,
      showDevSystemMessagesInStream,
      currentProject?.cwd,
      setWorkdir,
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
