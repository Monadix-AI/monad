import type { MeshAgentConfig } from '@monad/environment';
import type { Event, ManagedMeshAgentLifecycleLogEvent, MeshSessionView, Session, SessionId } from '@monad/protocol';
import type { SessionContext } from '#/handlers/session/context.ts';
import type { MeshAgentTargetId } from '#/store/db/mesh-sessions.ts';

import { mkdirSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { extractError } from '#/agent/index.ts';
import { HandlerError } from '#/handlers/handler-error.ts';
import {
  managedMeshAgentResumeRecoveryNotice,
  meshAgentInputText
} from '#/handlers/session/handlers/messaging-notices.ts';
import { makeEvent } from '#/services/event-bus.ts';
import { managedProjectSharedWorkspace } from '#/services/mesh-agent/managed-project.ts';

const MANAGED_MESH_AGENT_RESUME_FAILED_COLD_START_EVENT =
  'project.managed_mesh.resume_failed_cold_start' satisfies ManagedMeshAgentLifecycleLogEvent;

// Module-level (not per-closure): shared across every createManagedMeshAgentRuntime call site
// (messaging + join each create one). The running-state guard is check-then-act across several
// awaits, so two concurrent flows (double updateProject, or join racing a fan-out) would otherwise
// cold-start the same member twice and deliver its input twice. Entries live only for the start window.
const inflightManagedMeshAgentStarts = new Map<string, { promise: Promise<MeshSessionView>; inputs: Set<string> }>();

export type StartManagedMeshAgentRuntimeArgs = {
  session: Session;
  spec: MeshAgentConfig;
  // The owning ProjectMember. Threaded into the host/launcher managed-start contract so ownership + the
  // member's SessionBinding current pointer are established BEFORE the provider's initial turn opens.
  // Required: a managed runtime is never started unowned.
  projectMemberId: string;
  runtimeAgentName: string;
  templateAgentName: string;
  displayName?: string;
  workingDirectoryOverride?: string;
  modelName?: string;
  modelId?: string;
  reasoningEffort?: string;
  speed?: 'standard' | 'fast';
  customPrompt?: string;
  allowAutopilot?: boolean;
  providerSessionRef?: string;
  input: string;
};

/** Cold-starts (or resumes) a managed-project-agent MeshAgent process and de-dupes concurrent starts
 *  for the same (session, agent) pair — a check-then-act race across several awaits, so two concurrent
 *  callers (a fan-out delivery racing a member-join) would otherwise cold-start the same member twice
 *  and deliver its input twice. Extracted from managed-mesh-agent-delivery.ts: this is pure process
 *  lifecycle, with no dependency on the delivery/thinking-message machinery that calls it. */
export function createManagedMeshAgentRuntime(ctx: SessionContext) {
  const {
    deps: { log, meshAgentHost, paths },
    makeEmit,
    persistAndRetire
  } = ctx;

  function managedMeshSessionsForMember(
    transcriptTargetId: MeshAgentTargetId,
    projectMemberId: string
  ): MeshSessionView[] {
    return (meshAgentHost?.list(transcriptTargetId).sessions ?? []).filter(
      (candidate) => candidate.projectMemberId === projectMemberId && candidate.runtimeRole === 'managed-project-agent'
    );
  }

  async function startManagedMeshAgentRuntime({
    session,
    spec,
    projectMemberId,
    runtimeAgentName,
    templateAgentName,
    displayName,
    workingDirectoryOverride,
    modelName,
    modelId,
    reasoningEffort,
    speed,
    customPrompt,
    allowAutopilot,
    providerSessionRef,
    input
  }: StartManagedMeshAgentRuntimeArgs): Promise<MeshSessionView> {
    if (!meshAgentHost) throw new HandlerError('internal', 'MeshAgent host not configured');
    const currentSession = ctx.requireSession(session.id);
    if (!currentSession.projectId)
      throw new HandlerError('invalid', `MeshAgent "${spec.name}" requires a project binding`);
    const normalizedWorkingDirectoryOverride = workingDirectoryOverride?.trim();
    if (normalizedWorkingDirectoryOverride && !isAbsolute(normalizedWorkingDirectoryOverride)) {
      throw new HandlerError('invalid', `MeshAgent "${spec.name}" working directory override must be absolute`);
    }
    const configuredWorkingPath = normalizedWorkingDirectoryOverride || currentSession.cwd;
    const workingPath =
      configuredWorkingPath ??
      (paths?.home
        ? managedProjectSharedWorkspace({
            monadHome: paths.home,
            projectId: currentSession.projectId
          })
        : undefined);
    if (!workingPath) throw new HandlerError('invalid', `MeshAgent "${spec.name}" requires a project working path`);
    if (!configuredWorkingPath) mkdirSync(workingPath, { recursive: true });
    const startArgs = {
      transcriptTargetId: session.id,
      projectId: currentSession.projectId,
      agentName: runtimeAgentName,
      projectMemberId,
      displayName,
      templateAgentName,
      workingPath,
      allowAutopilot,
      runtimeRole: 'managed-project-agent' as const,
      modelName,
      modelId,
      reasoningEffort,
      speed,
      customPrompt,
      initialInput: meshAgentInputText(input)
    };
    try {
      const nativeSession = await meshAgentHost.start({
        ...startArgs,
        providerSessionRef
      });
      return nativeSession;
    } catch (err) {
      if (!providerSessionRef) throw err;
      const { code: extractedCode, message } = extractError(err);
      const code = extractedCode ?? 'resume_failed';
      log?.debug(
        {
          sessionId: session.id,
          event: MANAGED_MESH_AGENT_RESUME_FAILED_COLD_START_EVENT,
          agentName: runtimeAgentName,
          providerSessionRef,
          code,
          message
        },
        'managed native cli resume failed; cold starting'
      );
      const round: Event[] = [];
      makeEmit(round)(
        makeEvent(session.id as SessionId, 'mesh.resume_failed', {
          agentName: runtimeAgentName,
          provider: spec.provider,
          providerSessionRef,
          code,
          message,
          fallback: 'cold-start'
        })
      );
      persistAndRetire(session.id, round);
      const nativeSession = await meshAgentHost.start({
        ...startArgs,
        initialInput: meshAgentInputText(managedMeshAgentResumeRecoveryNotice(spec.provider, input))
      });
      return nativeSession;
    }
  }

  async function startManagedMeshAgentRuntimeWithRecovery(
    args: StartManagedMeshAgentRuntimeArgs
  ): Promise<MeshSessionView> {
    if (!meshAgentHost) throw new HandlerError('internal', 'MeshAgent host not configured');
    const key = `${args.session.id}:${args.runtimeAgentName}`;
    const inflight = inflightManagedMeshAgentStarts.get(key);
    if (inflight) {
      const nativeSession = await inflight.promise;
      if (!inflight.inputs.has(args.input)) {
        inflight.inputs.add(args.input);
        await meshAgentHost.input(nativeSession.id, { input: meshAgentInputText(args.input) });
      }
      return nativeSession;
    }
    const entry = { promise: startManagedMeshAgentRuntime(args), inputs: new Set([args.input]) };
    inflightManagedMeshAgentStarts.set(key, entry);
    try {
      return await entry.promise;
    } finally {
      inflightManagedMeshAgentStarts.delete(key);
    }
  }

  return { managedMeshSessionsForMember, startManagedMeshAgentRuntimeWithRecovery };
}
