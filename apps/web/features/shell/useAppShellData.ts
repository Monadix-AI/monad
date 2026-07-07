'use client';

import type { ProfileView } from '@monad/protocol';

import {
  nativeCliSessionSelectors,
  profileSelectors,
  sessionAdapter,
  sessionSelectors,
  useGetHealthQuery,
  useGetRolesQuery,
  useListLiveNativeCliSessionsQuery,
  useListNativeCliSessionSummariesQuery,
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

export function useAppShellData() {
  const { data: health, isError: healthError } = useGetHealthQuery();
  const daemonStatus: DaemonStatus = health?.status === 'ok' ? 'online' : healthError ? 'offline' : 'checking';
  const daemonVersion = health?.version;
  const hasUpgrade = Boolean(
    (health as { latestVersion?: string; version?: string } | undefined)?.latestVersion &&
      (health as { latestVersion?: string; version?: string } | undefined)?.latestVersion !==
        (health as { latestVersion?: string; version?: string } | undefined)?.version
  );

  const { data: sessionData, isLoading: sessionsLoading } = useListSessionsQuery(undefined);
  const { data: projectData } = useListWorkplaceProjectsQuery(undefined);
  const { data: liveNativeCliSessionData } = useListLiveNativeCliSessionsQuery(undefined);
  const { data: nativeCliSessionSummaryData } = useListNativeCliSessionSummariesQuery(undefined);
  const sessions = sessionSelectors.selectAll(sessionData?.sessions ?? sessionAdapter.getInitialState());
  const projectRows = useMemo(
    () => workplaceProjectSelectors.selectAll(projectData?.projects ?? workplaceProjectAdapter.getInitialState()),
    [projectData]
  );
  const liveNativeCliSessions = useMemo(
    () => (liveNativeCliSessionData ? nativeCliSessionSelectors.selectAll(liveNativeCliSessionData.sessions) : []),
    [liveNativeCliSessionData]
  );
  const nativeCliSessionSummaries = useMemo(
    () =>
      nativeCliSessionSummaryData ? nativeCliSessionSelectors.selectAll(nativeCliSessionSummaryData.sessions) : [],
    [nativeCliSessionSummaryData]
  );
  const pinnedProjectIds = useWorkspaceShellStore((state: WorkspaceShellState) => state.pinnedProjectIds);
  const pinnedProjectIdSet = useMemo(() => new Set(pinnedProjectIds), [pinnedProjectIds]);
  const workspaceProjects = useMemo(
    () =>
      buildWorkspaceProjects(projectRows, {
        liveNativeCliSessions,
        nativeCliSessions: nativeCliSessionSummaries,
        pinnedProjectIds: pinnedProjectIdSet
      }),
    [liveNativeCliSessions, nativeCliSessionSummaries, pinnedProjectIdSet, projectRows]
  );

  useStreamControlQuery(undefined);

  const {
    data: profileData,
    isError: profileDataError,
    isLoading: profileDataLoading
  } = useListProfilesQuery(undefined);
  const profiles = profileData ? profileSelectors.selectAll(profileData.profiles) : EMPTY_PROFILES;
  const defaultProfile = profiles.find((profile) => profile.alias === profileData?.defaultAlias);
  const { data: modelRoles, isError: modelRolesError, isLoading: modelRolesLoading } = useGetRolesQuery(undefined);
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
    profiles,
    sessions,
    sessionsLoading,
    voiceModelConfigured,
    voiceModelState,
    workspaceProjects
  };
}
