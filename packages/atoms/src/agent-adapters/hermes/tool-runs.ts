import type { AgentObservationEvent } from '@monad/protocol';
import type { MeshAgentObservationToolRun } from '@monad/sdk-atom';

function unpairedToolCallIsStreaming(call: AgentObservationEvent): boolean {
  const status = call.tool?.status?.trim().toLowerCase();
  return status !== 'completed' && status !== 'success' && status !== 'succeeded' && status !== 'failed';
}

export function hermesToolRuns(events: readonly AgentObservationEvent[]): MeshAgentObservationToolRun[] {
  const results = new Map<string, AgentObservationEvent[]>();
  for (const event of events) {
    if (event.kind !== 'tool-result' || !event.tool?.callId) continue;
    const candidates = results.get(event.tool.callId) ?? [];
    candidates.push(event);
    results.set(event.tool.callId, candidates);
  }
  const claimed = new Set<AgentObservationEvent>();
  return events.flatMap((call) => {
    if (call.kind !== 'tool-call') return [];
    const result = call.tool?.callId
      ? results.get(call.tool.callId)?.find((candidate) => !claimed.has(candidate))
      : undefined;
    if (result) claimed.add(result);
    const run = {
      call,
      consumed: result ? [result] : [],
      ...(result ? { result } : {}),
      streaming: result ? result.streaming : unpairedToolCallIsStreaming(call)
    };
    if (!result?.tool || result.tool.durationMs !== undefined || call.tool?.durationMs !== undefined) {
      return [run];
    }
    const startedAt = call.at ? Date.parse(call.at) : Number.NaN;
    const completedAt = result.at ? Date.parse(result.at) : Number.NaN;
    if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) return [run];
    return [{ ...run, result: { ...result, tool: { ...result.tool, durationMs: completedAt - startedAt } } }];
  });
}
