'use client';

// Single chokepoint between the workspace shell and the live monad backend.
// Experience-specific transcript, rail, and composer projections live in atoms.

import type {
  ExternalAgentSessionView,
  ProfileView,
  ProjectId,
  Session,
  SessionId,
  UIItem,
  WorkplaceProject
} from '@monad/protocol';

import { useProjectExperienceProjection } from '@monad/atoms/workspace-experiences';
import {
  externalAgentSessionSelectors,
  profileSelectors,
  projectSessionSelectors,
  useCreateProjectSessionMutation,
  useDeleteSessionMutation,
  useGetAppearanceQuery,
  useGetProfileSettingsQuery,
  useListExternalAgentSessionsQuery,
  useListProfilesQuery,
  useListProjectSessionsQuery,
  useListWorkplaceProjectsQuery,
  useStreamUiItemsQuery,
  workplaceProjectAdapter,
  workplaceProjectSelectors
} from '@monad/client-rtk';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useAcpAgentSettings } from '#/hooks/use-acp-agent-settings';
import { useExternalAgentSettings } from '#/hooks/use-external-agent-settings';
import { useTranscriptHistory } from '#/hooks/use-transcript-history';
import { normalizedComposerSettings } from '#/lib/composer-settings';
import { getWorkplaceProjectName } from '#/lib/workspace-sessions';
import { DEV_SYSTEM_MESSAGES_IN_STREAM_ENABLED, useProjectDebugStore } from './debug/project-debug-store';
import { useWorkspaceProjectExperienceRuntime } from './experiences/project-experience-adapter';
import { useProjectActions } from './use-project-actions';

const EMPTY_PROFILES: ProfileView[] = [];
const EMPTY_ITEMS: UIItem[] = [];
const EMPTY_EXTERNAL_AGENT_SESSIONS: ExternalAgentSessionView[] = [];

export function useProject(
  projectId: string,
  opts: { openAgentCard?: (memberId: string) => void; switchExperience?: (id: string) => void } = {}
) {
  const [resolvedProjectId, setResolvedProjectId] = useState<ProjectId | null>(null);

  // --- projects ---
  const { data: projectData } = useListWorkplaceProjectsQuery(undefined);
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: projectId is the route param that resets the resolved project session.
  useEffect(() => {
    setResolvedProjectId(null);
  }, [projectId]);

  useEffect(() => {
    const existing = workplaceProjects.find((project) => project.id === projectId);
    if (existing) {
      if (resolvedProjectId !== existing.id) setResolvedProjectId(existing.id);
      return;
    }
    if (projectData && resolvedProjectId !== null) setResolvedProjectId(null);
  }, [projectData, projectId, workplaceProjects, resolvedProjectId]);

  const currentProject = useMemo(
    () => (resolvedProjectId ? (workplaceProjects.find((project) => project.id === resolvedProjectId) ?? null) : null),
    [workplaceProjects, resolvedProjectId]
  );
  const activeProjectId = currentProject?.id ?? null;

  // --- project session resolution (Track B: a project's own id is no longer a conversation id) ---
  // No default session is auto-created when a project is made; this is the minimal owed UI —
  // resolve to the project's most-recently-active session, or silently create one on first open so
  // the existing single-conversation shell keeps working without a multi-session tab strip (P7).
  const { data: projectSessionData } = useListProjectSessionsQuery(activeProjectId ?? ('prj_' as ProjectId), {
    skip: activeProjectId === null
  });
  const projectSessions: Session[] = useMemo(
    () => (projectSessionData ? projectSessionSelectors.selectAll(projectSessionData) : []),
    [projectSessionData]
  );
  const [createProjectSession] = useCreateProjectSessionMutation();
  const [deleteSession] = useDeleteSessionMutation();
  const creatingSessionForProject = useRef<ProjectId | null>(null);
  // Manual pick (tab click) wins over the default; forgotten when the project changes so a fresh
  // project always starts on its own default rather than a stale sibling's manual selection.
  const [sessionOverride, setSessionOverride] = useState<SessionId | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeProjectId is the reset trigger, not a read value.
  useEffect(() => {
    setSessionOverride(null);
  }, [activeProjectId]);
  const defaultSessionId: SessionId | null = useMemo(() => {
    if (projectSessions.length === 0) return null;
    return [...projectSessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id ?? null;
  }, [projectSessions]);
  const activeSessionId: SessionId | null =
    sessionOverride && projectSessions.some((session) => session.id === sessionOverride)
      ? sessionOverride
      : defaultSessionId;

  useEffect(() => {
    if (!activeProjectId || !currentProject) return;
    if (!projectSessionData) return; // wait for the list query to settle before deciding it's empty
    if (projectSessions.length > 0) return;
    if (creatingSessionForProject.current === activeProjectId) return;
    creatingSessionForProject.current = activeProjectId;
    void createProjectSession({ projectId: activeProjectId, title: currentProject.title })
      .unwrap()
      .catch(() => {
        creatingSessionForProject.current = null;
      });
  }, [activeProjectId, currentProject, projectSessionData, projectSessions, createProjectSession]);

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
  const externalAgentSessionsQ = useListExternalAgentSessionsQuery(activeSessionId ?? ('ses_' as SessionId), {
    skip: activeSessionId === null
  });
  const transcript = useTranscriptHistory({
    sessionId: activeSessionId,
    streamOldestCursor: stream.data?.oldestCursor,
    streamHasMore: stream.data?.hasMore ?? false
  });

  const acp = useAcpAgentSettings();
  const externalAgent = useExternalAgentSettings();
  const externalAgentSessions = useMemo(
    () =>
      externalAgentSessionsQ.data
        ? externalAgentSessionSelectors.selectAll(externalAgentSessionsQ.data)
        : EMPTY_EXTERNAL_AGENT_SESSIONS,
    [externalAgentSessionsQ.data]
  );
  const projection = useProjectExperienceProjection({
    acpAgents: acp.agents,
    activeProjectId,
    appearanceAvatarStyle: appearance?.avatarStyle,
    currentProject,
    liveItems: stream.data?.items ?? EMPTY_ITEMS,
    externalAgents: externalAgent.agents,
    externalAgentSessions,
    projectId,
    projectName: getWorkplaceProjectName,
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
    externalAgentAvatarSeeds,
    externalAgentDisplayNames,
    externalAgentIcons,
    externalAgentTags,
    participants,
    projectParticipants,
    projectMembers,
    projects
  } = projection;
  const showDevSystemMessagesInStream = useProjectDebugStore((state) => state.showDevSystemMessagesInStream);

  // The daemon starts a managed member's external-agent session server-side (join / first delivery),
  // so no client mutation ever fires to invalidate `listExternalAgentSessions`'s RTK Query cache — the
  // join notice would otherwise only ever be backed by the bounded live-items window and vanish once a
  // long turn's events push the launch record out of it. Refetch the durable session list the moment a
  // new external-agent session id shows up live, so the REST-backed join view takes over before that
  // happens. Tracked in a ref (not state) so this never re-renders on its own.
  const refetchedExternalAgentSessionIds = useRef(new Set<string>());
  useEffect(() => {
    refetchedExternalAgentSessionIds.current.clear();
  }, []);
  useEffect(() => {
    const knownIds = new Set(externalAgentSessions.map((session) => session.id));
    const unseenLiveId = liveTools.find(
      (tool) =>
        tool.tool.startsWith('external-agent:') &&
        !knownIds.has(tool.id) &&
        !refetchedExternalAgentSessionIds.current.has(tool.id)
    );
    if (!unseenLiveId) return;
    refetchedExternalAgentSessionIds.current.add(unseenLiveId.id);
    void externalAgentSessionsQ.refetch();
  }, [liveTools, externalAgentSessions, externalAgentSessionsQ]);

  const loadOlder = transcript.loadOlder;

  const {
    sendDirective,
    resolveApproval,
    answerQuestion,
    pauseAll,
    deleteProject,
    switchProject,
    addProjectMember,
    removeProjectMember,
    updateProjectMemberSettings,
    updateProjectMemberIdentity,
    sendExternalAgentInput,
    stopExternalAgent,
    setWorkdir
  } = useProjectActions({
    activeProjectId,
    activeSessionId,
    currentProject,
    projectMembers,
    approvals,
    acpAgents: acp.agents,
    externalAgents: externalAgent.agents,
    avatarStyle: appearance?.avatarStyle,
    setResolvedProjectId
  });

  const controller = useMemo(
    () => ({
      projectId,
      activeProjectId,
      activeSessionId,
      projectSessions,
      ready: activeProjectId !== null,
      // live collections
      projects,
      participants,
      projectParticipants,
      projectMembers,
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
        externalAgentSessions,
        human,
        avatarStyle: appearance?.avatarStyle,
        externalAgentAvatarSeeds,
        externalAgentTags,
        externalAgentDisplayNames,
        externalAgentIcons,
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
      switchProject,
      addProjectMember,
      removeProjectMember,
      updateProjectMemberSettings,
      updateProjectMemberIdentity,
      sendExternalAgentInput,
      stopExternalAgent,
      switchSession,
      closeSession
    }),
    [
      activeProjectId,
      activeSessionId,
      projectSessions,
      switchSession,
      closeSession,
      projectId,
      projects,
      participants,
      projectParticipants,
      projectMembers,
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
      externalAgentSessions,
      human,
      appearance?.avatarStyle,
      externalAgentAvatarSeeds,
      externalAgentTags,
      externalAgentDisplayNames,
      externalAgentIcons,
      showDevSystemMessagesInStream,
      currentProject?.cwd,
      setWorkdir,
      sendDirective,
      resolveApproval,
      answerQuestion,
      pauseAll,
      deleteProject,
      switchProject,
      addProjectMember,
      removeProjectMember,
      updateProjectMemberSettings,
      updateProjectMemberIdentity,
      sendExternalAgentInput,
      stopExternalAgent
    ]
  );
  const experienceRuntime = useWorkspaceProjectExperienceRuntime(controller, opts);

  return useMemo(() => {
    return {
      ...controller,
      experienceRuntime
    };
  }, [controller, experienceRuntime]);
}

export type ProjectController = ReturnType<typeof useProject>;
