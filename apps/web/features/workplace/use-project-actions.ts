import type {
  AvatarStyle,
  ExternalAgentAppServerTransport,
  ProjectId,
  SendMessageAttachment,
  SessionId,
  WorkplaceProject,
  WorkplaceProjectMemberSettings,
  WorkplaceProjectMemberType,
  WorkplaceProjectMemberView
} from '@monad/protocol';
import type { useAcpAgentSettings } from '#/hooks/use-acp-agent-settings';
import type { useExternalAgentSettings } from '#/hooks/use-external-agent-settings';

import {
  useAbortSessionMutation,
  useApproveExternalAgentSessionMutation,
  useApproveToolMutation,
  useClarifyRespondMutation,
  useDeleteWorkplaceProjectMutation,
  useInputExternalAgentSessionMutation,
  useSendProjectMessageMutation,
  useStopExternalAgentSessionMutation,
  useUpdateWorkplaceProjectMutation
} from '@monad/client-rtk';
import {
  defaultWorkplaceProjectMemberSettings,
  entityAvatarWriteUrl,
  externalAgentProductDisplayName,
  newExternalAgentInstanceId,
  renameExternalAgentProjectMemberDisplayName,
  safeExternalAgentDisplayName,
  uniqueExternalAgentDisplayName,
  workplaceProjectMemberAvatarSeeds,
  workplaceProjectMemberId
} from '@monad/protocol';
import { useCallback } from 'react';

import { traceProjectDebugOperation } from '#/lib/project-debug-trace';

export type ApprovalDecision = 'approve' | 'reject';

type ProjectApprovalActionView = {
  id: string;
  approvalOwnership?: 'provider-owned';
  externalAgentSessionId?: string;
};

type AddProjectMemberOptions = {
  displayName?: string;
  projectTemplateId?: string;
  modelId?: string;
  reasoningEffort?: string;
  speed?: 'standard' | 'fast';
  appServerTransport?: ExternalAgentAppServerTransport;
  customPrompt?: string;
};

function warmEntityAvatar(seed: string, avatarStyle?: AvatarStyle): void {
  void fetch(entityAvatarWriteUrl(seed, avatarStyle), { method: 'POST' }).catch(() => {});
}

/** Every mutating action `useProject` exposes: message send, approval/clarify resolution, session
 *  lifecycle, and project-member CRUD. Extracted from useProject because these are a cohesive,
 *  self-contained action surface — each callback only needs the RTK mutation hooks and the handful
 *  of computed values passed in, none of the surrounding view-building state. */
export function useProjectActions(args: {
  activeProjectId: ProjectId | null;
  activeSessionId: SessionId | null;
  approvals: ProjectApprovalActionView[];
  currentProject: WorkplaceProject | null;
  projectMembers: WorkplaceProjectMemberView[];
  acpAgents: ReturnType<typeof useAcpAgentSettings>['agents'];
  externalAgents: ReturnType<typeof useExternalAgentSettings>['agents'];
  avatarStyle?: AvatarStyle;
  setResolvedProjectId: (id: ProjectId | null) => void;
}) {
  const {
    activeProjectId,
    activeSessionId,
    approvals,
    currentProject,
    projectMembers,
    acpAgents,
    externalAgents,
    avatarStyle,
    setResolvedProjectId
  } = args;

  const [sendProjectMessage] = useSendProjectMessageMutation();
  const [approveTool] = useApproveToolMutation();
  const [clarifyRespond] = useClarifyRespondMutation();
  const [approveExternalAgentSession] = useApproveExternalAgentSessionMutation();
  const [abortSession] = useAbortSessionMutation();
  const [updateWorkplaceProject] = useUpdateWorkplaceProjectMutation();
  const [deleteWorkplaceProject] = useDeleteWorkplaceProjectMutation();
  const [inputExternalAgentSession] = useInputExternalAgentSessionMutation();
  const [stopExternalAgentSession] = useStopExternalAgentSessionMutation();

  const sendDirective = useCallback(
    async (directive: string | { attachments?: SendMessageAttachment[]; text: string }) => {
      if (!activeSessionId) return;
      const text = typeof directive === 'string' ? directive : directive.text;
      const attachments = typeof directive === 'string' ? undefined : directive.attachments;
      await traceProjectDebugOperation(
        { layer: 'web', label: 'project.message.send', sessionId: activeSessionId, data: { attachments, text } },
        () => sendProjectMessage({ sessionId: activeSessionId, text, attachments }).unwrap()
      );
    },
    [activeSessionId, sendProjectMessage]
  );

  const resolveApproval = useCallback(
    (requestId: string, decision: ApprovalDecision) => {
      const approval = approvals.find((candidate) => candidate.id === requestId);
      if (activeSessionId && approval?.approvalOwnership === 'provider-owned' && approval.externalAgentSessionId) {
        void traceProjectDebugOperation(
          {
            layer: 'web',
            label: 'external-agent.approval.resolve',
            sessionId: approval.externalAgentSessionId,
            data: { requestId, decision }
          },
          () =>
            approveExternalAgentSession({
              id: approval.externalAgentSessionId as string,
              transcriptTargetId: activeSessionId,
              requestId,
              allow: decision === 'approve',
              ...(decision === 'reject' ? { reason: 'denied by operator' } : {})
            }).unwrap()
        );
        return;
      }
      void traceProjectDebugOperation(
        {
          layer: 'web',
          label: 'tool.approval.resolve',
          sessionId: activeSessionId ?? undefined,
          data: { requestId, decision }
        },
        () =>
          approveTool({
            requestId,
            allow: decision === 'approve',
            scope: 'once',
            ...(decision === 'reject' ? { reason: 'denied by operator' } : {})
          }).unwrap()
      );
    },
    [activeSessionId, approveExternalAgentSession, approveTool, approvals]
  );

  const answerQuestion = useCallback(
    (requestId: string, answer: string) => {
      void traceProjectDebugOperation(
        {
          layer: 'web',
          label: 'clarify.respond',
          sessionId: activeSessionId ?? undefined,
          data: { requestId }
        },
        () => clarifyRespond({ requestId, answer }).unwrap()
      );
    },
    [activeSessionId, clarifyRespond]
  );

  const pauseAll = useCallback(() => {
    if (activeSessionId) void abortSession(activeSessionId);
  }, [activeSessionId, abortSession]);

  const deleteProject = useCallback(async () => {
    if (!activeProjectId) return;
    const deletedProjectId = activeProjectId;
    setResolvedProjectId(null);
    try {
      await traceProjectDebugOperation({ layer: 'web', label: 'project.delete', sessionId: deletedProjectId }, () =>
        deleteWorkplaceProject(deletedProjectId).unwrap()
      );
    } catch (error) {
      setResolvedProjectId(deletedProjectId);
      throw error;
    }
  }, [activeProjectId, deleteWorkplaceProject, setResolvedProjectId]);

  const switchProject = useCallback((id: string) => setResolvedProjectId(id as ProjectId), [setResolvedProjectId]);

  const updateProjectMembers = useCallback(
    async (nextMembers: WorkplaceProjectMemberView[]) => {
      if (!currentProject) return;
      await updateWorkplaceProject({
        id: currentProject.id,
        memberTemplates: nextMembers.map(({ id, type, name, displayName, settings }) => ({
          id,
          type,
          name,
          ...(displayName ? { displayName } : {}),
          ...(settings && Object.keys(settings).length > 0 ? { settings } : {})
        }))
      }).unwrap();
      for (const seed of workplaceProjectMemberAvatarSeeds(currentProject.id, nextMembers)) {
        warmEntityAvatar(seed, avatarStyle);
      }
    },
    [currentProject, updateWorkplaceProject, avatarStyle]
  );

  const addProjectMember = useCallback(
    async (type: WorkplaceProjectMemberType, name: string, options: AddProjectMemberOptions = {}) => {
      if (type !== 'external-agent' && projectMembers.some((member) => member.type === type && member.name === name))
        return;
      const acpAgent = type === 'acp' ? acpAgents.find((agent) => agent.name === name) : undefined;
      const nativeAgent = type === 'external-agent' ? externalAgents.find((agent) => agent.name === name) : undefined;
      const settings = {
        ...defaultWorkplaceProjectMemberSettings(type, type === 'acp' ? acpAgent : nativeAgent),
        ...(options.modelId ? { modelId: options.modelId } : {}),
        ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
        ...(options.speed ? { speed: options.speed } : {}),
        ...(options.appServerTransport ? { appServerTransport: options.appServerTransport } : {}),
        ...(options.customPrompt ? { customPrompt: options.customPrompt } : {})
      };
      if (type === 'external-agent') {
        const defaultDisplayName = externalAgentProductDisplayName(
          nativeAgent?.productIcon,
          nativeAgent?.provider,
          name
        );
        const displayName = safeExternalAgentDisplayName(
          uniqueExternalAgentDisplayName(options.displayName?.trim() || defaultDisplayName, projectMembers)
        );
        const instanceId = newExternalAgentInstanceId(name);
        await updateProjectMembers([
          ...projectMembers,
          {
            id: instanceId,
            type,
            // `name` stays the real, configured external-agent name (config resolution reads
            // `templateName ?? name`) — the user-facing label lives only in `displayName`.
            name,
            displayName,
            instanceId,
            settings
          }
        ]);
        return;
      }
      await updateProjectMembers([
        ...projectMembers,
        { id: workplaceProjectMemberId(type, name), type, name, settings }
      ]);
    },
    [acpAgents, externalAgents, projectMembers, updateProjectMembers]
  );

  const removeProjectMember = useCallback(
    async (id: string) => {
      await updateProjectMembers(projectMembers.filter((member) => member.id !== id));
    },
    [projectMembers, updateProjectMembers]
  );

  const updateProjectMemberSettings = useCallback(
    async (id: string, patch: WorkplaceProjectMemberSettings) => {
      await updateProjectMembers(
        projectMembers.map((member) =>
          member.id === id ? { ...member, settings: { ...(member.settings ?? {}), ...patch } } : member
        )
      );
    },
    [projectMembers, updateProjectMembers]
  );

  const updateProjectMemberIdentity = useCallback(
    async (id: string, patch: { displayName?: string }) => {
      await updateProjectMembers(
        projectMembers.map((member) => {
          if (member.id !== id) return member;
          return renameExternalAgentProjectMemberDisplayName(member, patch.displayName);
        })
      );
    },
    [projectMembers, updateProjectMembers]
  );

  const sendExternalAgentInput = useCallback(
    async (id: string, input: string) => {
      if (!activeSessionId) return;
      await traceProjectDebugOperation(
        { layer: 'web', label: 'external-agent.input', sessionId: id, data: { id, input } },
        () => inputExternalAgentSession({ id, transcriptTargetId: activeSessionId, input }).unwrap()
      );
    },
    [activeSessionId, inputExternalAgentSession]
  );
  const stopExternalAgent = useCallback(
    async (id: string) => {
      if (!activeSessionId) return;
      await traceProjectDebugOperation(
        { layer: 'web', label: 'external-agent.stop', sessionId: id, data: { id } },
        () => stopExternalAgentSession({ id, transcriptTargetId: activeSessionId }).unwrap()
      );
    },
    [activeSessionId, stopExternalAgentSession]
  );

  const setWorkdir = useCallback(
    async (path: string) => {
      if (!currentProject) return;
      await updateWorkplaceProject({ id: currentProject.id, cwd: path }).unwrap();
    },
    [currentProject, updateWorkplaceProject]
  );

  return {
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
  };
}
