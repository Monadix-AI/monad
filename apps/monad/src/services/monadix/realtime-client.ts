import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import type { SubmitResultBody, TaskDispatchAckPayload } from './protocol.ts';

import { createClient } from '@supabase/supabase-js';

import {
  monadixChannels,
  monadixEvents,
  taskDispatchedPayloadSchema,
  taskFollowUpDispatchedPayloadSchema
} from './protocol.ts';
import { monadixHttpError } from './register.ts';
import { createDispatchDeduper, handleDispatchedTask } from './task-bridge.ts';

interface RealtimeLogger {
  warn(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
}

export interface MonadixRealtimeDeps {
  supabaseUrl: string;
  supabaseAnonKey: string;
  providerId: string;
  apiBase: string;
  /** Bearer token for the result-submit API (the MCP OAuth access token). */
  token: string;
  /** Run one inbound task on a local agent → final text (throws on failure). */
  runAgent(task: { taskId: string; prompt: string }): Promise<string>;
  logger: RealtimeLogger;
  now?: () => string;
}

export interface MonadixRealtimeHandle {
  stop(): Promise<void>;
}

/**
 * Connect the daemon to Monadix's Supabase Realtime as a native provider (dial-out; no public URL):
 * join the presence heartbeat, subscribe to this provider's task channel, and route each dispatched
 * task through the task bridge. Reconnection is handled by supabase-js. Best-effort — a connect
 * failure logs and leaves the daemon otherwise healthy.
 */
export function startMonadixRealtime(deps: MonadixRealtimeDeps): MonadixRealtimeHandle {
  const now = deps.now ?? (() => new Date().toISOString());
  const client: SupabaseClient = createClient(deps.supabaseUrl, deps.supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 10 } }
  });
  const deduper = createDispatchDeduper();

  const submitResult = async (taskId: string, body: SubmitResultBody): Promise<void> => {
    const res = await fetch(`${deps.apiBase}/network/tasks/${encodeURIComponent(taskId)}/result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${deps.token}` },
      body: JSON.stringify(body)
    });
    if (!res.ok) await monadixHttpError(res, 'monadix result submit failed');
  };

  // Broadcast the dispatch ack on its own short-lived channel (cabinet subscribes before dispatching).
  // Best-effort and never-hanging: resolve on any terminal subscribe status and on a timeout, so a
  // failed ack channel can't wedge the awaiting task run (cabinet re-broadcasts; the deduper covers
  // a re-delivery). Only `send` when actually subscribed.
  const ack = async (payload: TaskDispatchAckPayload): Promise<void> => {
    const ackChannel = client.channel(monadixChannels.taskDispatchAck(payload.dispatchId));
    try {
      const subscribed = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 5000);
        ackChannel.subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            clearTimeout(timer);
            resolve(true);
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            clearTimeout(timer);
            resolve(false);
          }
        });
      });
      if (subscribed) await ackChannel.send({ type: 'broadcast', event: monadixEvents.taskDispatchAck, payload });
    } catch (err) {
      deps.logger.warn({ dispatchId: payload.dispatchId, err: String(err) }, 'monadix: ack failed');
    } finally {
      await client.removeChannel(ackChannel).catch(() => {});
    }
  };

  const onDispatch = (raw: unknown, follow: boolean): void => {
    const parsed = follow
      ? taskFollowUpDispatchedPayloadSchema.safeParse(raw)
      : taskDispatchedPayloadSchema.safeParse(raw);
    if (!parsed.success) {
      deps.logger.warn({ issues: parsed.error.issues, follow }, 'monadix: unparseable dispatch payload');
      return;
    }
    const payload = parsed.data;
    if (deduper.seen(payload.dispatchId)) return;
    void handleDispatchedTask(
      // Follow-up carries `prompt` too; normalize to the dispatched shape the bridge consumes.
      { ...payload, description: 'description' in payload ? payload.description : '', input: null, matchScore: null },
      { providerId: deps.providerId, ack, runAgent: deps.runAgent, submitResult, now, logger: deps.logger }
    );
  };

  const tasks: RealtimeChannel = client.channel(monadixChannels.providerTasks(deps.providerId));
  tasks
    .on('broadcast', { event: monadixEvents.taskDispatched }, (m) => onDispatch(m.payload, false))
    .on('broadcast', { event: monadixEvents.taskFollowUpDispatched }, (m) => onDispatch(m.payload, true))
    .subscribe((status) => deps.logger.info({ status, providerId: deps.providerId }, 'monadix task channel'));

  // Presence heartbeat so cabinet's stale-provider cron sees us online.
  const heartbeat = client.channel(monadixChannels.heartbeatProviders, {
    config: { presence: { key: deps.providerId } }
  });
  heartbeat.subscribe((status) => {
    if (status === 'SUBSCRIBED') void heartbeat.track({ providerId: deps.providerId, online: true, at: now() });
  });

  return {
    async stop(): Promise<void> {
      await client.removeChannel(tasks).catch(() => {});
      await client.removeChannel(heartbeat).catch(() => {});
      await client.removeAllChannels().catch(() => {});
    }
  };
}
