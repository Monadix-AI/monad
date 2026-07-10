'use client';

// Single chokepoint between the workspace shell and the live monad backend.
// Experience-specific transcript, rail, and composer projections live in atoms.

import type {
  ExternalAgentSessionId,
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
import { externalAgentSessionIdSchema } from '@monad/protocol';
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
  opts: {
    openAgentCard?: (memberId: string) => void;
    routedSessionId?: SessionId | null;
    switchExperience?: (id: string) => void;
  } = {}
) {
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
  const currentProject = useMemo(
    () => workplaceProjects.find((project) => project.id === projectId) ?? null,
    [projectId, workplaceProjects]
  );
  const activeProjectId = currentProject?.id ?? null;

  // --- project session resolution (Track B: a project's own id is no longer a conversation id) ---
  // Project sessions are explicit. Opening a project with no sessions leaves the active session empty
  // instead of silently creating a project-name session.
  const { data: projectSessionData } = useListProjectSessionsQuery(
    { projectId: activeProjectId ?? ('prj_' as ProjectId) },
    { skip: activeProjectId === null }
  );
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
    if (projectSessions.length === 0) return null;
    return [...projectSessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id ?? null;
  }, [projectSessions]);
  const routedSessionId =
    opts.routedSessionId && projectSessions.some((session) => session.id === opts.routedSessionId)
      ? opts.routedSessionId
      : null;
  const activeSessionId: SessionId | null =
    routedSessionId ??
    (sessionOverride && projectSessions.some((session) => session.id === sessionOverride)
      ? sessionOverride
      : defaultSessionId);

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
  const refetchedExternalAgentSessionIds = useRef(new Set<ExternalAgentSessionId>());
  const refetchExternalAgentSessions = externalAgentSessionsQ.refetch;
  const knownExternalAgentSessionIds = useMemo(
    () => new Set(externalAgentSessions.map((session) => session.id)),
    [externalAgentSessions]
  );
  useEffect(() => {
    refetchedExternalAgentSessionIds.current.clear();
  }, []);
  useEffect(() => {
    for (const tool of liveTools) {
      if (!tool.tool.startsWith('external-agent:')) continue;
      const parsedId = externalAgentSessionIdSchema.safeParse(tool.id);
      if (!parsedId.success) continue;
      if (knownExternalAgentSessionIds.has(parsedId.data)) continue;
      if (refetchedExternalAgentSessionIds.current.has(parsedId.data)) continue;
      refetchedExternalAgentSessionIds.current.add(parsedId.data);
      void refetchExternalAgentSessions();
      return;
    }
  }, [liveTools, knownExternalAgentSessionIds, refetchExternalAgentSessions]);

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
    avatarStyle: appearance?.avatarStyle
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
