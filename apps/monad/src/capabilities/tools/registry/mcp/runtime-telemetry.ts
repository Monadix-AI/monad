export type McpAppRefreshOutcome = 'aborted' | 'failed' | 'stale' | 'succeeded';
export type McpUrlElicitationOutcome = 'accepted' | 'cancelled' | 'declined';

const refreshOutcomes: Record<McpAppRefreshOutcome, number> = {
  aborted: 0,
  failed: 0,
  stale: 0,
  succeeded: 0
};
const elicitationOutcomes: Record<McpUrlElicitationOutcome, number> = {
  accepted: 0,
  cancelled: 0,
  declined: 0
};
let refreshCount = 0;
let refreshDurationMs = 0;
let refreshDurationMaxMs = 0;

export function recordMcpAppRefresh(outcome: McpAppRefreshOutcome, durationMs: number): void {
  refreshOutcomes[outcome] += 1;
  refreshCount += 1;
  refreshDurationMs += durationMs;
  refreshDurationMaxMs = Math.max(refreshDurationMaxMs, durationMs);
}

export function recordMcpUrlElicitation(outcome: McpUrlElicitationOutcome): void {
  elicitationOutcomes[outcome] += 1;
}

export function mcpRuntimeTelemetrySnapshot(): {
  elicitationOutcomes: Record<McpUrlElicitationOutcome, number>;
  refreshDurationAvgMs: number;
  refreshDurationMaxMs: number;
  refreshOutcomes: Record<McpAppRefreshOutcome, number>;
} {
  return {
    refreshOutcomes: { ...refreshOutcomes },
    refreshDurationAvgMs: refreshCount ? refreshDurationMs / refreshCount : 0,
    refreshDurationMaxMs,
    elicitationOutcomes: { ...elicitationOutcomes }
  };
}
