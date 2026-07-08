import type { ExternalAgentConfig } from '@monad/home';
import type {
  Event,
  ExternalAgentSessionView,
  ManagedExternalAgentLifecycleLogEvent,
  Session,
  SessionId
} from '@monad/protocol';
import type { SessionContext } from '#/handlers/session/context.ts';
import type { ExternalAgentTargetId } from '#/store/db/external-agent-sessions.ts';

import { newId } from '@monad/protocol';

import { extractError } from '#/agent/index.ts';
import { HandlerError } from '#/handlers/handler-error.ts';
import {
  externalAgentInputText,
  managedExternalAgentResumeRecoveryNotice
} from '#/handlers/session/handlers/messaging-notices.ts';

const MANAGED_EXTERNAL_AGENT_RESUME_FAILED_COLD_START_EVENT =
  'project.managed_external_agent.resume_failed_cold_start' satisfies ManagedExternalAgentLifecycleLogEvent;

// Module-level (not per-closure): shared across every createManagedExternalAgentRuntime call site
// (messaging + join each create one). The running-state guard is check-then-act across several
// awaits, so two concurrent flows (double updateProject, or join racing a fan-out) would otherwise
// cold-start the same member twice and deliver its input twice. Entries live only for the start window.
const inflightManagedExternalAgentStarts = new Map<
  string,
  { promise: Promise<ExternalAgentSessionView>; inputs: Set<string> }
>();

export type StartManagedExternalAgentRuntimeArgs = {
  session: Session;
  spec: ExternalAgentConfig;
  runtimeAgentName: string;
  templateAgentName: string;
  displayName: string;
  modelName?: string;
  modelId?: string;
  reasoningEffort?: string;
  speed?: 'standard' | 'fast';
  customPrompt?: string;
  launchMode: ExternalAgentConfig['defaultLaunchMode'];
  appServerTransport?: ExternalAgentConfig['appServerTransport'];
  allowAutopilot?: boolean;
  providerSessionRef?: string;
  input: string;
};

/** Cold-starts (or resumes) a managed-project-agent external agent process and de-dupes concurrent starts
 *  for the same (session, agent) pair — a check-then-act race across several awaits, so two concurrent
 *  callers (a fan-out delivery racing a member-join) would otherwise cold-start the same member twice
 *  and deliver its input twice. Extracted from managed-external-agent-delivery.ts: this is pure process
 *  lifecycle, with no dependency on the delivery/thinking-message machinery that calls it. */
export function createManagedExternalAgentRuntime(ctx: SessionContext) {
  const {
    deps: { log, externalAgentHost },
    makeEmit,
    persistAndRetire
  } = ctx;

  function managedExternalAgentSessionsForAgent(
    transcriptTargetId: ExternalAgentTargetId,
    agentName: string
  ): ExternalAgentSessionView[] {
    return (externalAgentHost?.list(transcriptTargetId).sessions ?? []).filter(
      (candidate) => candidate.agentName === agentName && candidate.runtimeRole === 'managed-project-agent'
    );
  }

  async function startManagedExternalAgentRuntime({
    session,
    spec,
    runtimeAgentName,
    templateAgentName,
    displayName,
    modelName,
    modelId,
    reasoningEffort,
    speed,
    customPrompt,
    launchMode,
    appServerTransport,
    allowAutopilot,
    providerSessionRef,
    input
  }: StartManagedExternalAgentRuntimeArgs): Promise<ExternalAgentSessionView> {
    if (!externalAgentHost) throw new HandlerError('internal', 'external agent host not configured');
    if (!session.cwd)
      throw new HandlerError('invalid', `external agent "${spec.name}" requires a project working path`);
    const startArgs = {
      transcriptTargetId: session.id,
      agentName: runtimeAgentName,
      displayName,
      templateAgentName,
      workingPath: session.cwd,
      launchMode,
      appServerTransport,
      allowAutopilot,
      runtimeRole: 'managed-project-agent' as const,
      modelName,
      modelId,
      reasoningEffort,
      speed,
      customPrompt
    };
    try {
      const nativeSession = await externalAgentHost.start({
        ...startArgs,
        providerSessionRef
      });
      await externalAgentHost.input(nativeSession.id, { input: externalAgentInputText(input) });
      return nativeSession;
    } catch (err) {
      if (!providerSessionRef) throw err;
      const { code, message } = extractError(err);
      log?.debug(
        {
          sessionId: session.id,
          event: MANAGED_EXTERNAL_AGENT_RESUME_FAILED_COLD_START_EVENT,
          agentName: runtimeAgentName,
          providerSessionRef,
          code,
          message
        },
        'managed native cli resume failed; cold starting'
      );
      const round: Event[] = [];
      makeEmit(round)({
        id: newId('evt'),
        sessionId: session.id as SessionId,
        type: 'external_agent.resume_failed',
        actorAgentId: null,
        payload: {
          agentName: runtimeAgentName,
          provider: spec.provider,
          providerSessionRef,
          code,
          message,
          fallback: 'cold-start'
        },
        at: new Date().toISOString()
      });
      persistAndRetire(session.id, round);
      const nativeSession = await externalAgentHost.start(startArgs);
      await externalAgentHost.input(nativeSession.id, {
        input: externalAgentInputText(managedExternalAgentResumeRecoveryNotice(spec.provider, input))
      });
      return nativeSession;
    }
  }

  async function startManagedExternalAgentRuntimeWithRecovery(
    args: StartManagedExternalAgentRuntimeArgs
  ): Promise<ExternalAgentSessionView> {
    if (!externalAgentHost) throw new HandlerError('internal', 'external agent host not configured');
    const key = `${args.session.id}:${args.runtimeAgentName}`;
    const inflight = inflightManagedExternalAgentStarts.get(key);
    if (inflight) {
      const nativeSession = await inflight.promise;
      if (!inflight.inputs.has(args.input)) {
        inflight.inputs.add(args.input);
        await externalAgentHost.input(nativeSession.id, { input: externalAgentInputText(args.input) });
      }
      return nativeSession;
    }
    const entry = { promise: startManagedExternalAgentRuntime(args), inputs: new Set([args.input]) };
    inflightManagedExternalAgentStarts.set(key, entry);
    try {
      return await entry.promise;
    } finally {
      inflightManagedExternalAgentStarts.delete(key);
    }
  }

  return { managedExternalAgentSessionsForAgent, startManagedExternalAgentRuntimeWithRecovery };
}
