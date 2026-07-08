'use client';

import type { ProfileView } from '@monad/protocol';

import {
  externalAgentSessionSelectors,
  profileSelectors,
  sessionAdapter,
  sessionSelectors,
  useGetHealthQuery,
  useGetRolesQuery,
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

import { buildWorkspaceProjects } from '@/lib/workspace-sessions';
import { useWorkspaceShellStore, type WorkspaceShellState } from '@/lib/workspace-shell-store';

const EMPTY_PROFILES: ProfileView[] = [];

type DaemonStatus = 'checking' | 'offline' | 'online';
type VoiceModelState = 'checking' | 'configured' | 'failed' | 'missing';

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

  const { data: sessionData, isLoading: sessionsLoading } = useListSessionsQuery(undefined);
  const { data: projectData, isLoading: projectsLoading } = useListWorkplaceProjectsQuery(undefined);
  const { data: liveExternalAgentSessionData } = useListLiveExternalAgentSessionsQuery(undefined);
  const { data: externalAgentSessionSummaryData } = useListExternalAgentSessionSummariesQuery(undefined);
  const sessions = sessionSelectors.selectAll(sessionData?.sessions ?? sessionAdapter.getInitialState());
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
  const pinnedProjectIds = useWorkspaceShellStore((state: WorkspaceShellState) => state.pinnedProjectIds);
  const pinnedProjectIdSet = useMemo(() => new Set(pinnedProjectIds), [pinnedProjectIds]);
  const workspaceProjects = useMemo(
    () =>
      buildWorkspaceProjects(projectRows, {
        sessions,
        liveExternalAgentSessions,
        externalAgentSessions: externalAgentSessionSummaries,
        pinnedProjectIds: pinnedProjectIdSet
      }),
    [sessions, liveExternalAgentSessions, externalAgentSessionSummaries, pinnedProjectIdSet, projectRows]
  );

  useStreamControlQuery(undefined);

  const {
    data: profileData,
    isError: profileDataError,
    isLoading: profileDataLoading
  } = useListProfilesQuery(undefined, { skip: !loadModelData });
  const profiles = profileData ? profileSelectors.selectAll(profileData.profiles) : EMPTY_PROFILES;
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
    networkRuntime,
    profiles,
    projectsLoading,
    sessions,
    sessionsLoading,
    voiceModelConfigured,
    voiceModelState,
    workspaceProjects
  };
}
