import type { SubmitResultBody, TaskDispatchAckPayload, TaskDispatchedPayload } from './protocol.ts';

interface BridgeLogger {
  warn(obj: unknown, msg?: string): void;
  info?(obj: unknown, msg?: string): void;
}

export interface TaskBridgeDeps {
  providerId: string;
  /** Broadcast the dispatch ack (proves receipt so cabinet stops re-broadcasting). */
  ack(payload: TaskDispatchAckPayload): Promise<void>;
  /** Run the inbound task on a local agent; resolves with the agent's final text, throws on failure. */
  runAgent(task: { taskId: string; prompt: string }): Promise<string>;
  /** POST the terminal result to cabinet. */
  submitResult(taskId: string, body: SubmitResultBody): Promise<void>;
  now(): string;
  logger?: BridgeLogger;
}

/**
 * Handle one dispatched Monadix task: ack it, run it on a local agent, submit the result. Ack happens
 * BEFORE the (slow) agent run so cabinet's ack-retry loop stops immediately. A run failure is reported
 * as a `failed` result rather than thrown, so one bad task never wedges the subscription. The
 * per-dispatch `dispatchSecret` is echoed on submission (receipt proof). Caller dedupes by dispatchId.
 */
export async function handleDispatchedTask(payload: TaskDispatchedPayload, deps: TaskBridgeDeps): Promise<void> {
  await deps.ack({
    dispatchId: payload.dispatchId,
    taskId: payload.taskId,
    providerId: deps.providerId,
    timestamp: deps.now()
  });
  try {
    const text = await deps.runAgent({ taskId: payload.taskId, prompt: payload.prompt });
    await deps.submitResult(payload.taskId, {
      status: 'completed',
      output: { text },
      ...(payload.dispatchSecret ? { dispatchSecret: payload.dispatchSecret } : {})
    });
  } catch (err) {
    deps.logger?.warn({ taskId: payload.taskId, err: String(err) }, 'monadix task run failed');
    await deps
      .submitResult(payload.taskId, {
        status: 'failed',
        output: { error: err instanceof Error ? err.message : String(err) },
        ...(payload.dispatchSecret ? { dispatchSecret: payload.dispatchSecret } : {})
      })
      .catch((e) =>
        deps.logger?.warn({ taskId: payload.taskId, err: String(e) }, 'monadix failed-result submit failed')
      );
  }
}

/** Bounded dedupe of dispatch ids — cabinet may re-broadcast the same dispatchId; run each once. */
export function createDispatchDeduper(max = 512): { seen(id: string): boolean } {
  const ids = new Set<string>();
  return {
    seen(id: string): boolean {
      if (ids.has(id)) return true;
      ids.add(id);
      if (ids.size > max) {
        const oldest = ids.values().next().value;
        if (oldest !== undefined) ids.delete(oldest);
      }
      return false;
    }
  };
}
