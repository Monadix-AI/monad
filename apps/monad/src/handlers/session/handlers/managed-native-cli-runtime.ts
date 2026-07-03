import type { NativeCliAgentConfig } from '@monad/home';
import type { Event, ManagedNativeCliLifecycleLogEvent, NativeCliSessionView, TranscriptTarget } from '@monad/protocol';
import type { SessionContext } from '@/handlers/session/context.ts';

import { newId } from '@monad/protocol';

import { extractError } from '@/agent/index.ts';
import { HandlerError } from '@/handlers/handler-error.ts';
import {
  managedNativeCliResumeRecoveryNotice,
  nativeCliInputText
} from '@/handlers/session/handlers/messaging-notices.ts';

const MANAGED_NATIVE_CLI_RESUME_FAILED_COLD_START_EVENT =
  'project.managed_native_cli.resume_failed_cold_start' satisfies ManagedNativeCliLifecycleLogEvent;

// Module-level (not per-closure): shared across every createManagedNativeCliRuntime call site
// (messaging + join each create one). The running-state guard is check-then-act across several
// awaits, so two concurrent flows (double updateProject, or join racing a fan-out) would otherwise
// cold-start the same member twice and deliver its input twice. Entries live only for the start window.
const inflightManagedNativeCliStarts = new Map<
  string,
  { promise: Promise<NativeCliSessionView>; inputs: Set<string> }
>();

export type StartManagedNativeCliRuntimeArgs = {
  session: TranscriptTarget;
  spec: NativeCliAgentConfig;
  runtimeAgentName: string;
  templateAgentName: string;
  displayName: string;
  modelName?: string;
  modelId?: string;
  reasoningEffort?: string;
  speed?: 'standard' | 'fast';
  customPrompt?: string;
  launchMode: NativeCliAgentConfig['defaultLaunchMode'];
  providerSessionRef?: string;
  input: string;
};

/** Cold-starts (or resumes) a managed-project-agent native CLI process and de-dupes concurrent starts
 *  for the same (session, agent) pair — a check-then-act race across several awaits, so two concurrent
 *  callers (a fan-out delivery racing a member-join) would otherwise cold-start the same member twice
 *  and deliver its input twice. Extracted from managed-native-cli-delivery.ts: this is pure process
 *  lifecycle, with no dependency on the delivery/thinking-message machinery that calls it. */
export function createManagedNativeCliRuntime(ctx: SessionContext) {
  const {
    deps: { log, nativeCliHost },
    makeEmit,
    persistAndRetire
  } = ctx;

  function managedNativeCliSessionsForAgent(
    transcriptTargetId: TranscriptTarget['id'],
    agentName: string
  ): NativeCliSessionView[] {
    return (nativeCliHost?.list(transcriptTargetId).sessions ?? []).filter(
      (candidate) => candidate.agentName === agentName && candidate.runtimeRole === 'managed-project-agent'
    );
  }

  async function startManagedNativeCliRuntime({
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
    providerSessionRef,
    input
  }: StartManagedNativeCliRuntimeArgs): Promise<NativeCliSessionView> {
    if (!nativeCliHost) throw new HandlerError('internal', 'native CLI host not configured');
    if (!session.cwd)
      throw new HandlerError('invalid', `native CLI agent "${spec.name}" requires a project working path`);
    const startArgs = {
      transcriptTargetId: session.id,
      agentName: runtimeAgentName,
      displayName,
      templateAgentName,
      workingPath: session.cwd,
      launchMode,
      runtimeRole: 'managed-project-agent' as const,
      modelName,
      modelId,
      reasoningEffort,
      speed,
      customPrompt
    };
    try {
      const nativeSession = await nativeCliHost.start({
        ...startArgs,
        providerSessionRef
      });
      nativeCliHost.input(nativeSession.id, { input: nativeCliInputText(input) });
      return nativeSession;
    } catch (err) {
      if (!providerSessionRef) throw err;
      const { code, message } = extractError(err);
      log?.debug(
        {
          sessionId: session.id,
          event: MANAGED_NATIVE_CLI_RESUME_FAILED_COLD_START_EVENT,
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
        transcriptTargetId: session.id,
        type: 'native_cli.resume_failed',
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
      const nativeSession = await nativeCliHost.start(startArgs);
      nativeCliHost.input(nativeSession.id, { input: nativeCliInputText(managedNativeCliResumeRecoveryNotice(input)) });
      return nativeSession;
    }
  }

  async function startManagedNativeCliRuntimeWithRecovery(
    args: StartManagedNativeCliRuntimeArgs
  ): Promise<NativeCliSessionView> {
    if (!nativeCliHost) throw new HandlerError('internal', 'native CLI host not configured');
    const key = `${args.session.id}:${args.runtimeAgentName}`;
    const inflight = inflightManagedNativeCliStarts.get(key);
    if (inflight) {
      const nativeSession = await inflight.promise;
      if (!inflight.inputs.has(args.input)) {
        inflight.inputs.add(args.input);
        nativeCliHost.input(nativeSession.id, { input: nativeCliInputText(args.input) });
      }
      return nativeSession;
    }
    const entry = { promise: startManagedNativeCliRuntime(args), inputs: new Set([args.input]) };
    inflightManagedNativeCliStarts.set(key, entry);
    try {
      return await entry.promise;
    } finally {
      inflightManagedNativeCliStarts.delete(key);
    }
  }

  return { managedNativeCliSessionsForAgent, startManagedNativeCliRuntimeWithRecovery };
}
