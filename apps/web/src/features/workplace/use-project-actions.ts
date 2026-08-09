import type {
  AvatarStyle,
  InvitableMeshAgent,
  MessageId,
  ProjectId,
  SendMessageAttachment,
  SessionId,
  WorkplaceProject,
  WorkplaceProjectMemberSettings,
  WorkplaceProjectMemberType,
  WorkplaceProjectMemberView
} from '@monad/protocol';
import type { WorkplaceApprovalDecision } from '@monad/sdk-experience';
import type { useAcpAgentSettings } from '#/hooks/use-acp-agent-settings';

import {
  useAbortSessionMutation,
  useApproveMeshSessionMutation,
  useApproveToolMutation,
  useClarifyRespondMutation,
  useDeleteWorkplaceProjectMutation,
  useInputMeshSessionMutation,
  useSendProjectMessageMutation,
  useStopMeshSessionMutation,
  useUpdateWorkplaceProjectMutation
} from '@monad/client-rtk';
import {
  defaultWorkplaceProjectMemberSettings,
  entityAvatarWriteUrl,
  meshAgentProductDisplayName,
  newMeshAgentInstanceId,
  renameMeshAgentProjectMemberDisplayName,
  safeMeshAgentDisplayName,
  uniqueMeshAgentDisplayName,
  workplaceProjectMemberAvatarSeeds,
  workplaceProjectMemberId
} from '@monad/protocol';
import { useCallback } from 'react';

import { traceProjectDebugOperation } from '#/lib/project-debug-trace';

type ProjectApprovalActionView = {
  id: string;
  approvalOwnership?: 'provider-owned';
  meshSessionId?: string;
};

type AddProjectMemberOptions = {
  displayName?: string;
  modelId?: string;
  reasoningEffort?: string;
  speed?: 'standard' | 'fast';
  customPrompt?: string;
};

function defaultMeshAgentMemberDisplayName(
  agent: Pick<InvitableMeshAgent, 'displayName' | 'name' | 'productIcon' | 'provider'>
): string {
  return agent.displayName ?? meshAgentProductDisplayName(agent.productIcon, agent.provider, agent.name);
}

export function projectApprovalResolution(decision: WorkplaceApprovalDecision) {
  const allow = decision !== 'reject';
  const scope = decision === 'approve-session' ? 'session' : decision === 'approve-always' ? 'global' : 'once';
  return {
    allow,
    scope,
    ...(allow ? {} : { reason: 'denied by operator' })
  } as const;
}

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
  meshAgents: readonly InvitableMeshAgent[];
  avatarStyle?: AvatarStyle;
}) {
  const {
    activeProjectId,
    activeSessionId,
    approvals,
    currentProject,
    projectMembers,
    acpAgents,
    meshAgents,
    avatarStyle
  } = args;

  const [sendProjectMessage] = useSendProjectMessageMutation();
  const [approveTool] = useApproveToolMutation();
  const [clarifyRespond] = useClarifyRespondMutation();
  const [approveMeshSession] = useApproveMeshSessionMutation();
  const [abortSession] = useAbortSessionMutation();
  const [updateWorkplaceProject] = useUpdateWorkplaceProjectMutation();
  const [deleteWorkplaceProject] = useDeleteWorkplaceProjectMutation();
  const [inputMeshSession] = useInputMeshSessionMutation();
  const [stopMeshSession] = useStopMeshSessionMutation();

  const sendDirective = useCallback(
    async (directive: string | { attachments?: SendMessageAttachment[]; replyToMessageId?: string; text: string }) => {
      if (!activeSessionId) return;
      const text = typeof directive === 'string' ? directive : directive.text;
      const attachments = typeof directive === 'string' ? undefined : directive.attachments;
      const replyToMessageId = typeof directive === 'string' ? undefined : directive.replyToMessageId;
      await traceProjectDebugOperation(
        {
          layer: 'web',
          label: 'project.message.send',
          sessionId: activeSessionId,
          data: { attachments, replyToMessageId, text }
        },
        () =>
          sendProjectMessage({
            sessionId: activeSessionId,
            text,
            attachments,
            replyToMessageId: replyToMessageId as MessageId | undefined
          }).unwrap()
      );
    },
    [activeSessionId, sendProjectMessage]
  );

  const resolveApproval = useCallback(
    (requestId: string, decision: WorkplaceApprovalDecision) => {
      const approval = approvals.find((candidate) => candidate.id === requestId);
      const resolution = projectApprovalResolution(decision);
      if (activeSessionId && approval?.approvalOwnership === 'provider-owned' && approval.meshSessionId) {
        void traceProjectDebugOperation(
          {
            layer: 'web',
            label: 'mesh-agent.approval.resolve',
            sessionId: approval.meshSessionId,
            data: { requestId, decision, scope: resolution.scope }
          },
          () =>
            approveMeshSession({
              id: approval.meshSessionId as string,
              transcriptTargetId: activeSessionId,
              requestId,
              ...resolution
            }).unwrap()
        );
        return;
      }
      void traceProjectDebugOperation(
        {
          layer: 'web',
          label: 'tool.approval.resolve',
          sessionId: activeSessionId ?? undefined,
          data: { requestId, decision, scope: resolution.scope }
        },
        () =>
          approveTool({
            requestId,
            ...resolution
          }).unwrap()
      );
    },
    [activeSessionId, approveMeshSession, approveTool, approvals]
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
    await traceProjectDebugOperation({ layer: 'web', label: 'project.delete', sessionId: deletedProjectId }, () =>
      deleteWorkplaceProject(deletedProjectId).unwrap()
    );
  }, [activeProjectId, deleteWorkplaceProject]);

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
      if (type !== 'mesh-agent' && projectMembers.some((member) => member.type === type && member.name === name))
        return;
      const acpAgent = type === 'acp' ? acpAgents.find((agent) => agent.name === name) : undefined;
      const nativeAgent = type === 'mesh-agent' ? meshAgents.find((agent) => agent.name === name) : undefined;
      const settings = {
        ...defaultWorkplaceProjectMemberSettings(type, type === 'acp' ? acpAgent : nativeAgent),
        ...(options.modelId ? { modelId: options.modelId } : {}),
        ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
        ...(options.speed ? { speed: options.speed } : {}),
        ...(options.customPrompt ? { customPrompt: options.customPrompt } : {})
      };
      if (type === 'mesh-agent') {
        const defaultDisplayName = nativeAgent
          ? defaultMeshAgentMemberDisplayName(nativeAgent)
          : meshAgentProductDisplayName(undefined, undefined, name);
        const displayName = safeMeshAgentDisplayName(
          uniqueMeshAgentDisplayName(options.displayName?.trim() || defaultDisplayName, projectMembers)
        );
        const instanceId = newMeshAgentInstanceId(name);
        await updateProjectMembers([
          ...projectMembers,
          {
            id: instanceId,
            type,
            name,
            displayName,
            instanceId,
            settings
          }
        ]);
        return;
      }
      const memberId = workplaceProjectMemberId(type, name);
      await updateProjectMembers([...projectMembers, { id: memberId, type, name, settings }]);
    },
    [acpAgents, meshAgents, projectMembers, updateProjectMembers]
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
          return renameMeshAgentProjectMemberDisplayName(member, patch.displayName);
        })
      );
    },
    [projectMembers, updateProjectMembers]
  );

  const sendMeshAgentInput = useCallback(
    async (id: string, input: string) => {
      if (!activeSessionId) return;
      await traceProjectDebugOperation(
        { layer: 'web', label: 'mesh-agent.input', sessionId: id, data: { id, input } },
        () => inputMeshSession({ id, transcriptTargetId: activeSessionId, input }).unwrap()
      );
    },
    [activeSessionId, inputMeshSession]
  );
  const stopMeshAgent = useCallback(
    async (id: string) => {
      if (!activeSessionId) return;
      await traceProjectDebugOperation({ layer: 'web', label: 'mesh-agent.stop', sessionId: id, data: { id } }, () =>
        stopMeshSession({ id, transcriptTargetId: activeSessionId }).unwrap()
      );
    },
    [activeSessionId, stopMeshSession]
  );

  return {
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
  };
}
