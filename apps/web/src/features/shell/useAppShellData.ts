import type { Agent, ProfileView, Session } from '@monad/protocol';

import {
  agentAdapter,
  agentSelectors,
  externalAgentSessionSelectors,
  profileSelectors,
  sessionAdapter,
  sessionSelectors,
  useGetHealthQuery,
  useGetRolesQuery,
  useListAgentsQuery,
  useListExternalAgentSessionSummariesQuery,
  useListLiveExternalAgentSessionsQuery,
  useListProfilesQuery,
  useListSessionsQuery,
  useListWorkplaceProjectsQuery,
  useStreamControlQuery,
  workplaceProjectAdapter,
  workplaceProjectSelectors
} from '@monad/client-rtk';
import { useMemo } from 'react';

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
    ownerPrincipalId: 'prn_000000000000',
    state: 'active',
    agentIds: draft.agentId ? [draft.agentId] : [],
    archived: false,
    restoreCount: 0,
    origin: {
      surface: 'web',
      client: 'monad-web',
      transport: 'http',
      writableBy: ['http'],
      branchableBy: ['http'],
      ext: { draft: true, status: draft.status }
    },
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt
  };
}

export function useAppShellData({ loadModelData = true }: { loadModelData?: boolean } = {}) {
  const { data: health, isError: healthError } = useGetHealthQuery();
  const daemonStatus: DaemonStatus = health?.status === 'ok' ? 'online' : healthError ? 'offline' : 'checking';
  const daemonVersion = health?.version;
  const networkRuntime = health?.networkRuntime;
  const hasUpgrade = Boolean(
    (health as { latestVersion?: string; version?: string } | undefined)?.latestVersion &&
      (health as { latestVersion?: string; version?: string } | undefined)?.latestVersion !==
        (health as { latestVersion?: string; version?: string } | undefined)?.version
  );

  const {
    data: sessionData,
    isFetching: sessionsFetching,
    isLoading: sessionsLoading
  } = useListSessionsQuery({ archived: false });
  const { data: archivedSessionData, isLoading: archivedSessionsLoading } = useListSessionsQuery({ archived: true });
  const { data: projectData, isLoading: projectsLoading } = useListWorkplaceProjectsQuery(undefined);
  const { data: agentData } = useListAgentsQuery(undefined, { skip: !loadModelData });
  const { data: liveExternalAgentSessionData } = useListLiveExternalAgentSessionsQuery(undefined);
  const { data: externalAgentSessionSummaryData } = useListExternalAgentSessionSummariesQuery(undefined);
  const serverSessions = sessionSelectors.selectAll(sessionData?.sessions ?? sessionAdapter.getInitialState());
  const archivedSessions = sessionSelectors.selectAll(
    archivedSessionData?.sessions ?? sessionAdapter.getInitialState()
  );
  const draftChatSessions = useWorkspaceShellStore((state: WorkspaceShellState) => state.draftChatSessions);
  const sessions = useMemo(() => {
    const serverSessionIds = new Set(serverSessions.map((session) => session.id));
    const pendingDraftSessions = draftChatSessions
      .filter((draft) => !serverSessionIds.has(draft.id))
      .map(draftChatSessionToSession);
    return [...pendingDraftSessions, ...serverSessions];
  }, [draftChatSessions, serverSessions]);
  const projectRows = useMemo(
    () => workplaceProjectSelectors.selectAll(projectData?.projects ?? workplaceProjectAdapter.getInitialState()),
    [projectData]
  );
  const liveExternalAgentSessions = useMemo(
    () =>
      liveExternalAgentSessionData
        ? externalAgentSessionSelectors.selectAll(liveExternalAgentSessionData.sessions)
        : [],
    [liveExternalAgentSessionData]
  );
  const externalAgentSessionSummaries = useMemo(
    () =>
      externalAgentSessionSummaryData
        ? externalAgentSessionSelectors.selectAll(externalAgentSessionSummaryData.sessions)
        : [],
    [externalAgentSessionSummaryData]
  );
  const pinnedSessionIds = useWorkspaceShellStore((state: WorkspaceShellState) => state.pinnedSessionIds);
  const pinnedSessionIdSet = useMemo(() => new Set(pinnedSessionIds), [pinnedSessionIds]);
  const workspaceProjects = useMemo(
    () =>
      buildWorkspaceProjects(projectRows, {
        sessions,
        liveExternalAgentSessions,
        externalAgentSessions: externalAgentSessionSummaries,
        pinnedSessionIds: pinnedSessionIdSet
      }),
    [sessions, liveExternalAgentSessions, externalAgentSessionSummaries, pinnedSessionIdSet, projectRows]
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
    projectsLoading,
    sessions,
    sessionsFetching,
    sessionsLoading,
    voiceModelConfigured,
    voiceModelState,
    workspaceProjects
  };
}
