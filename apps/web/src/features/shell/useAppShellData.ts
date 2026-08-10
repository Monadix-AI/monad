import type { Agent, ProfileView, Session } from '@monad/protocol';

import {
  agentAdapter,
  agentSelectors,
  profileSelectors,
  sessionAdapter,
  sessionSelectors,
  useGetHealthQuery,
  useGetRolesQuery,
  useListAgentsQuery,
  useListProfilesQuery,
  useListSessionAttentionQuery,
  useListSessionsQuery,
  useListWorkplaceProjectsQuery,
  useStreamControlQuery,
  workplaceProjectAdapter,
  workplaceProjectSelectors
} from '@monad/client-rtk';
import { isUpgradeAvailable } from '@monad/utils/release-version';
import { useEffect, useMemo } from 'react';

import { buildWorkspaceProjects } from '#/lib/workspace-sessions';
import { useWorkspaceShellStore, type WorkspaceShellState } from '#/lib/workspace-shell-store';

const EMPTY_PROFILES: ProfileView[] = [];
const EMPTY_AGENTS: Agent[] = [];

type DaemonStatus = 'checking' | 'offline' | 'online';
type VoiceModelState = 'checking' | 'configured' | 'failed' | 'missing';

function draftChatSessionToSession(draft: WorkspaceShellState['draftChatSessions'][number]): Session {
  return {
    id: draft.id,
    title: draft.title,
    state: 'active',
    agentIds: draft.agentId ? [draft.agentId] : [],
    archived: false,
    restoreCount: 0,
    origin: {
      surface: 'web',
      client: 'monad-web',
      transport: 'http'
    },
    isDraft: true,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt
  };
}

export function mergeWorkspaceChatSessions(
  serverSessions: readonly Session[],
  draftChatSessions: readonly WorkspaceShellState['draftChatSessions'][number][]
): Session[] {
  const serverSessionIds = new Set(serverSessions.map((session) => session.id));
  const pendingDrafts = draftChatSessions.filter((draft) => !serverSessionIds.has(draft.id));
  const shadowedServerSessionIds = new Set(
    pendingDrafts.flatMap((draft) => (draft.serverSessionId ? [draft.serverSessionId] : []))
  );
  return [
    ...pendingDrafts.map(draftChatSessionToSession),
    ...serverSessions.filter((session) => !shadowedServerSessionIds.has(session.id))
  ];
}

export function useAppShellData({ loadModelData = true }: { loadModelData?: boolean } = {}) {
  const { data: health, isError: healthError } = useGetHealthQuery();
  const daemonStatus: DaemonStatus = health?.status === 'ok' ? 'online' : healthError ? 'offline' : 'checking';
  const daemonVersion = health?.version;
  const networkRuntime = health?.networkRuntime;
  const latestVersion = (health as { latestVersion?: string } | undefined)?.latestVersion;
  const hasUpgrade = Boolean(latestVersion && daemonVersion && isUpgradeAvailable(daemonVersion, latestVersion));

  const {
    data: sessionData,
    isFetching: sessionsFetching,
    isLoading: sessionsLoading
  } = useListSessionsQuery({ archived: false });
  const { data: archivedSessionData, isLoading: archivedSessionsLoading } = useListSessionsQuery({ archived: true });
  const { data: projectData, isLoading: projectsLoading } = useListWorkplaceProjectsQuery(undefined);
  const { data: agentData } = useListAgentsQuery(undefined, { skip: !loadModelData });
  const serverSessions = sessionSelectors.selectAll(sessionData?.sessions ?? sessionAdapter.getInitialState());
  const archivedSessions = sessionSelectors.selectAll(
    archivedSessionData?.sessions ?? sessionAdapter.getInitialState()
  );
  const draftChatSessions = useWorkspaceShellStore((state: WorkspaceShellState) => state.draftChatSessions);
  const reconcileDraftChatSessions = useWorkspaceShellStore(
    (state: WorkspaceShellState) => state.reconcileDraftChatSessions
  );
  useEffect(() => {
    if (draftChatSessions.length === 0) return;
    reconcileDraftChatSessions(serverSessions.map((session) => session.id));
  }, [draftChatSessions, reconcileDraftChatSessions, serverSessions]);
  const sessions = useMemo(
    () => mergeWorkspaceChatSessions(serverSessions, draftChatSessions),
    [draftChatSessions, serverSessions]
  );
  const sessionIds = useMemo(() => sessions.map((session) => session.id), [sessions]);
  const { data: attentionData } = useListSessionAttentionQuery({ sessionIds }, { skip: sessionIds.length === 0 });
  const sessionsWithAttention = useMemo(() => {
    const attention = new Map(attentionData?.summaries.map((summary) => [summary.sessionId, summary]));
    return sessions
      .map((session) => {
        const summary = attention.get(session.id);
        return {
          ...session,
          activityAt: summary?.activityAt ?? session.activityAt ?? session.updatedAt,
          attentionState: summary?.state ?? null,
          generationState: summary?.generationState ?? null,
          unreadItemKeys: summary?.unreadItemKeys ?? []
        };
      })
      .toSorted((a, b) => b.activityAt.localeCompare(a.activityAt) || b.id.localeCompare(a.id));
  }, [attentionData, sessions]);
  const projectRows = useMemo(
    () => workplaceProjectSelectors.selectAll(projectData?.projects ?? workplaceProjectAdapter.getInitialState()),
    [projectData]
  );
  const pinnedSessionIds = useWorkspaceShellStore((state: WorkspaceShellState) => state.pinnedSessionIds);
  const pinnedSessionIdSet = useMemo(() => new Set(pinnedSessionIds), [pinnedSessionIds]);
  const workspaceProjects = useMemo(
    () =>
      buildWorkspaceProjects(projectRows, {
        sessions: sessionsWithAttention,
        pinnedSessionIds: pinnedSessionIdSet
      }),
    [sessionsWithAttention, pinnedSessionIdSet, projectRows]
  );

  useStreamControlQuery(undefined);

  const {
    data: profileData,
    isError: profileDataError,
    isLoading: profileDataLoading
  } = useListProfilesQuery(undefined, { skip: !loadModelData });
  const profiles = profileData ? profileSelectors.selectAll(profileData.profiles) : EMPTY_PROFILES;
  const agents = agentData ? agentSelectors.selectAll(agentData ?? agentAdapter.getInitialState()) : EMPTY_AGENTS;
  const defaultProfile = profiles.find((profile) => profile.alias === profileData?.defaultAlias);
  const {
    data: modelRoles,
    isError: modelRolesError,
    isLoading: modelRolesLoading
  } = useGetRolesQuery(undefined, {
    skip: !loadModelData
  });
  const voiceModelConfigured = Boolean(
    modelRoles?.transcription && defaultProfile?.routes.chat.provider && defaultProfile.routes.chat.modelId
  );
  const voiceModelState: VoiceModelState =
    profileDataLoading || modelRolesLoading
      ? 'checking'
      : profileDataError || modelRolesError
        ? 'failed'
        : voiceModelConfigured
          ? 'configured'
          : 'missing';

  return {
    daemonStatus,
    daemonVersion,
    hasUpgrade,
    agents,
    defaultProfileAlias: profileData?.defaultAlias,
    archivedSessions,
    archivedSessionsLoading,
    networkRuntime,
    profiles,
    projectOrderRevision: projectData?.orderRevision ?? 0,
    projectsLoading,
    sessions: sessionsWithAttention,
    sessionsFetching,
    sessionsLoading,
    voiceModelConfigured,
    voiceModelState,
    workspaceProjects
  };
}
