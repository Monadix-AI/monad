import type { ManagedProjectOutputHandler } from '#/services/mesh-agent/host/host-types.ts';

type ManagedProjectOutput = Parameters<ManagedProjectOutputHandler>[0];

export interface ManagedProjectOutputHandlerDeps {
  getMeshSession: (meshSessionId: string) => { projectMemberId?: string | null } | null | undefined;
  completeProviderMessage: (input: {
    sessionId: ManagedProjectOutput['sessionId'];
    meshSessionId: string;
    projectMemberId: string;
    text: string;
    error?: boolean;
    post?: boolean;
  }) => Promise<unknown>;
  warn: (fields: Record<string, unknown>, message: string) => void;
}

// Fail closed on a runtime with no owning ProjectMember. The owner is stamped through the S2 binding path,
// so its absence means an unowned/corrupt runtime; falling back to the display alias would treat the alias
// as canonical identity and settle the wrong member's placeholder. Complete nothing and surface it instead.
export function createManagedProjectOutputHandler(deps: ManagedProjectOutputHandlerDeps): ManagedProjectOutputHandler {
  return async (output) => {
    const projectMemberId = deps.getMeshSession(output.meshSessionId)?.projectMemberId;
    if (!projectMemberId) {
      deps.warn(
        {
          event: 'managed_mesh.provider_output_unowned_runtime',
          meshSessionId: output.meshSessionId,
          agentName: output.agentName
        },
        'managed provider output for a runtime with no owning project member; skipping placeholder completion'
      );
      return;
    }
    await deps.completeProviderMessage({
      sessionId: output.sessionId,
      meshSessionId: output.meshSessionId,
      projectMemberId,
      text: output.text,
      ...(output.error === undefined ? {} : { error: output.error }),
      ...(output.post === undefined ? {} : { post: output.post })
    });
  };
}
