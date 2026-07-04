'use client';

// Single chokepoint between the workspace shell and the live monad backend.
// Experience-specific transcript, rail, and composer projections live in atoms.

import type { NativeCliSessionView, ProfileView, ProjectId, UIItem, WorkplaceProject } from '@monad/protocol';
import type { ApprovalDecision } from './use-project-actions';

import { createProjectExperienceRuntime } from '@monad/atoms/workspace-experiences';
import { useWorkspaceProjectProjection } from '@monad/atoms/workspace-experiences/project/use-workspace-project-projection';
import {
  nativeCliSessionSelectors,
  profileSelectors,
  useGetAppearanceQuery,
  useGetProfileSettingsQuery,
  useListNativeCliSessionsQuery,
  useListProfilesQuery,
  useListWorkplaceProjectsQuery,
  useStreamUiItemsQuery,
  workplaceProjectAdapter,
  workplaceProjectSelectors
} from '@monad/client-rtk';
import { useEffect, useMemo, useState } from 'react';

import { useAcpAgentSettings } from '@/hooks/use-acp-agent-settings';
import { useNativeCliAgentSettings } from '@/hooks/use-native-cli-agent-settings';
import { useTranscriptHistory } from '@/hooks/use-transcript-history';
import { getWorkplaceProjectName } from '@/lib/workspace-sessions';
import { useProjectActions } from './use-project-actions';
import { DEV_SYSTEM_MESSAGES_IN_STREAM_ENABLED, useWorkplaceUiStore } from './workplace-ui-store';

export type { ApprovalDecision };

const EMPTY_PROFILES: ProfileView[] = [];
const EMPTY_ITEMS: UIItem[] = [];
const EMPTY_NATIVE_CLI_SESSIONS: NativeCliSessionView[] = [];

export function useProject(
  projectId: string,
  opts: { openAgentCard?: (memberId: string) => void; switchExperience?: (id: string) => void } = {}
) {
  const [resolvedProjectId, setResolvedProjectId] = useState<ProjectId | null>(null);

  // --- projects ---
  const { data: projectData } = useListWorkplaceProjectsQuery(undefined);
  const { data: userProfile } = useGetProfileSettingsQuery();
  const { data: appearance } = useGetAppearanceQuery();
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

  // --- live stream + lazy older history ---
  const stream = useStreamUiItemsQuery(activeProjectId ?? ('prj_' as ProjectId), { skip: activeProjectId === null });
  const nativeCliSessionsQ = useListNativeCliSessionsQuery(activeProjectId ?? ('prj_' as ProjectId), {
    skip: activeProjectId === null
  });
  const transcript = useTranscriptHistory({
    transcriptTargetId: activeProjectId,
    streamOldestCursor: stream.data?.oldestCursor,
    streamHasMore: stream.data?.hasMore ?? false
  });

  const acp = useAcpAgentSettings();
  const nativeCli = useNativeCliAgentSettings();
  const nativeCliSessions = useMemo(
    () =>
      nativeCliSessionsQ.data
        ? nativeCliSessionSelectors.selectAll(nativeCliSessionsQ.data)
        : EMPTY_NATIVE_CLI_SESSIONS,
    [nativeCliSessionsQ.data]
  );
  const projection = useWorkspaceProjectProjection({
    acpAgents: acp.agents,
    activeProjectId,
    appearanceAvatarStyle: appearance?.avatarStyle,
    currentProject,
    liveItems: stream.data?.items ?? EMPTY_ITEMS,
    nativeCliAgents: nativeCli.agents,
    nativeCliSessions,
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
    nativeCliAvatarSeeds,
    nativeCliDisplayNames,
    nativeCliIcons,
    nativeCliTags,
    participants,
    projectParticipants,
    projectMembers,
    projects
  } = projection;
  const showDevSystemMessagesInStream = useWorkplaceUiStore((state) => state.showDevSystemMessagesInStream);

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
    sendNativeCliInput,
    stopNativeCli,
    setWorkdir
  } = useProjectActions({
    activeProjectId,
    currentProject,
    projectMembers,
    approvals,
    acpAgents: acp.agents,
    nativeCliAgents: nativeCli.agents,
    avatarStyle: appearance?.avatarStyle,
    setResolvedProjectId
  });

  return useMemo(() => {
    const controller = {
      projectId,
      activeProjectId,
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
      source: {
        project: currentProject,
        transcriptItems: transcript.items,
        liveItems,
        liveTools,
        nativeCliSessions,
        human,
        avatarStyle: appearance?.avatarStyle,
        nativeCliAvatarSeeds,
        nativeCliTags,
        nativeCliDisplayNames,
        nativeCliIcons,
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
      sendNativeCliInput,
      stopNativeCli
    };
    return {
      ...controller,
      experienceRuntime: createProjectExperienceRuntime(controller, {
        openAgentCard: opts.openAgentCard,
        switchExperience: opts.switchExperience ?? (() => {})
      })
    };
  }, [
    activeProjectId,
    projectId,
    projects,
    participants,
    projectParticipants,
    projectMembers,
    availableProjectMembers,
    approvals,
    loadOlder,
    modelProfiles,
    currentProject,
    transcript.items,
    liveItems,
    liveTools,
    nativeCliSessions,
    human,
    appearance?.avatarStyle,
    nativeCliAvatarSeeds,
    nativeCliTags,
    nativeCliDisplayNames,
    nativeCliIcons,
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
    sendNativeCliInput,
    stopNativeCli,
    opts.openAgentCard,
    opts.switchExperience
  ]);
}

export type ProjectController = ReturnType<typeof useProject>;
