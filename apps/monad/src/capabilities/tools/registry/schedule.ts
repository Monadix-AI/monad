// schedule.* — let the agent run a prompt later (one-shot) or on a recurring cron. Also
// send_later — a focused one-shot wakeup that always targets the CURRENT session (sessionId
// auto-filled from ToolContext; no cron). The timing/persistence/firing live in the daemon's
// ScheduleService (injected here as a `Scheduler`); these tools are the agent-facing surface,
// mirroring the clarify/delegate factory pattern. A fired schedule either starts a fresh
// session or, when `sessionId` is given, injects the prompt into that session — the daemon's
// fire callback decides.
//
// send_later is returned by createScheduleTools (not a separate factory) so schedule_cancel
// is always co-registered — the receipt id it returns is only useful with schedule_cancel.

import type { Tool, ToolContext, ToolInputSchema } from '#/capabilities/tools/types.ts';
import type { ToolModule } from './contract.ts';

import { z } from 'zod';

import { toolResult } from '#/capabilities/tools/types.ts';

export interface ScheduleCreateInput {
  prompt: string;
  /** 5-field cron expression for a recurring schedule. Mutually exclusive with at/delayMs. */
  cron?: string;
  /** ISO-8601 timestamp for a one-shot run. */
  at?: string;
  /** Milliseconds from now for a one-shot run. */
  delayMs?: number;
  /** Target an existing session; omit to start a fresh session on each fire. */
  sessionId?: string;
}

// Schema-first: persisted to disk by ScheduleService, so it is parsed (not cast) on load.
export const scheduleInfoSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  kind: z.enum(['cron', 'once']),
  spec: z.string(), // the cron expression or the resolved ISO fire time
  sessionId: z.string().optional(),
  nextFireAt: z.string().nullable(), // null once a one-shot has fired / nothing left to run
  createdAt: z.string()
});
export type ScheduleInfo = z.infer<typeof scheduleInfoSchema>;

/** Daemon-provided scheduling backend. `create` validates and may throw on a bad spec. */
export interface Scheduler {
  create(input: ScheduleCreateInput): ScheduleInfo;
  list(): ScheduleInfo[];
  cancel(id: string): boolean;
}

const createInput: ToolInputSchema<ScheduleCreateInput> = {
  safeParse: (input) => {
    const o = (input ?? {}) as Record<string, unknown>;
    if (typeof o.prompt !== 'string' || o.prompt.length === 0) {
      return { success: false, error: new Error('schedule_create requires a non-empty "prompt"') };
    }
    const specs = [o.cron, o.at, o.delayMs].filter((v) => v !== undefined);
    if (specs.length !== 1) {
      return { success: false, error: new Error('schedule_create requires exactly one of: cron, at, delayMs') };
    }
    if (o.cron !== undefined && typeof o.cron !== 'string') {
      return { success: false, error: new Error('"cron" must be a string') };
    }
    if (o.at !== undefined && typeof o.at !== 'string') {
      return { success: false, error: new Error('"at" must be an ISO-8601 string') };
    }
    if (o.delayMs !== undefined && (typeof o.delayMs !== 'number' || o.delayMs < 0)) {
      return { success: false, error: new Error('"delayMs" must be a non-negative number') };
    }
    if (o.sessionId !== undefined && typeof o.sessionId !== 'string') {
      return { success: false, error: new Error('"sessionId" must be a string') };
    }
    return {
      success: true,
      data: {
        prompt: o.prompt,
        cron: o.cron as string | undefined,
        at: o.at as string | undefined,
        delayMs: o.delayMs as number | undefined,
        sessionId: o.sessionId as string | undefined
      }
    };
  },
  toJsonSchema: () => ({
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'The prompt to run when the schedule fires' },
      cron: { type: 'string', description: '5-field cron expression for a recurring schedule' },
      at: { type: 'string', description: 'ISO-8601 timestamp for a one-shot run' },
      delayMs: { type: 'number', minimum: 0, description: 'Milliseconds from now for a one-shot run' },
      sessionId: { type: 'string', description: 'Target an existing session; omit to start fresh each fire' }
    },
    required: ['prompt'],
    description: 'Provide exactly one of: cron, at, delayMs.'
  })
};

const idInput: ToolInputSchema<{ id: string }> = {
  safeParse: (input) => {
    const id = (input as { id?: unknown })?.id;
    return typeof id === 'string' && id.length > 0
      ? { success: true, data: { id } }
      : { success: false, error: new Error('schedule_cancel requires an "id" string') };
  },
  toJsonSchema: () => ({
    type: 'object',
    properties: { id: { type: 'string', description: 'The schedule id to cancel' } },
    required: ['id']
  })
};

const emptyInput: ToolInputSchema<Record<string, never>> = {
  safeParse: () => ({ success: true, data: {} }),
  toJsonSchema: () => ({ type: 'object', properties: {} })
};

interface SendLaterInput {
  /** The prompt to inject into this session when the timer fires. */
  prompt: string;
  /** Milliseconds from now. Mutually exclusive with `at`. */
  delayMs?: number;
  /** ISO-8601 absolute timestamp to fire at. Mutually exclusive with `delayMs`. */
  at?: string;
}

interface SendLaterReceipt {
  /** Schedule id — pass to schedule_cancel to abort before it fires. */
  id: string;
  /** ISO-8601 time when the message will be injected. */
  firesAt: string;
}

const sendLaterInput: ToolInputSchema<SendLaterInput> = {
  safeParse: (input) => {
    const o = (input ?? {}) as Record<string, unknown>;
    if (typeof o.prompt !== 'string' || o.prompt.length === 0) {
      return { success: false, error: new Error('send_later requires a non-empty "prompt"') };
    }
    const specs = [o.delayMs, o.at].filter((v) => v !== undefined);
    if (specs.length !== 1) {
      return { success: false, error: new Error('send_later requires exactly one of: delayMs, at') };
    }
    if (o.delayMs !== undefined && (typeof o.delayMs !== 'number' || o.delayMs < 0)) {
      return { success: false, error: new Error('"delayMs" must be a non-negative number') };
    }
    if (o.at !== undefined && typeof o.at !== 'string') {
      return { success: false, error: new Error('"at" must be an ISO-8601 string') };
    }
    return {
      success: true,
      data: {
        prompt: o.prompt,
        delayMs: o.delayMs as number | undefined,
        at: o.at as string | undefined
      }
    };
  },
  toJsonSchema: () => ({
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'The prompt to inject when the timer fires' },
      delayMs: { type: 'number', minimum: 0, description: 'Milliseconds from now' },
      at: { type: 'string', description: 'ISO-8601 absolute timestamp to fire at' }
    },
    required: ['prompt'],
    description: 'Provide exactly one of: delayMs, at.'
  })
};

export function createScheduleTools(scheduler: Scheduler): Tool[] {
  const create: Tool<ScheduleCreateInput, ScheduleInfo> = {
    name: 'schedule_create',
    description:
      'Schedule a prompt to run later: one-shot via `at` (ISO time) or `delayMs`, or recurring via a 5-field `cron` expression. Omit `sessionId` to start a fresh session on each fire, or pass one to run inside an existing session. Returns the schedule id and next fire time.',
    scopes: [{ resource: 'schedule:write' }],
    inputSchema: createInput,
    inputExamples: [
      { prompt: 'Summarize today’s unread email', cron: '0 9 * * 1-5' },
      { prompt: 'Check the build status once', delayMs: 600_000 },
      { prompt: 'Post the standup reminder', at: '2026-06-15T09:00:00Z', sessionId: 'ses_existing0000' }
    ],
    run: async (input) => toolResult(scheduler.create(input))
  };

  const list: Tool<Record<string, never>, { schedules: ScheduleInfo[] }> = {
    name: 'schedule_list',
    description: 'List the currently active schedules (id, prompt, kind, next fire time).',
    scopes: [{ resource: 'schedule:read' }],
    inputSchema: emptyInput,
    run: async () => toolResult({ schedules: scheduler.list() })
  };

  const cancel: Tool<{ id: string }, { cancelled: boolean }> = {
    name: 'schedule_cancel',
    description: 'Cancel a schedule by id. Returns cancelled:false if the id is unknown.',
    scopes: [{ resource: 'schedule:write' }],
    inputSchema: idInput,
    run: async ({ id }) => toolResult({ cancelled: scheduler.cancel(id) })
  };

  const sendLater: Tool<SendLaterInput, SendLaterReceipt> = {
    name: 'send_later',
    description:
      'Schedule a one-shot prompt to be injected into this session at a future time. ' +
      'Use `delayMs` for a relative delay (e.g. 3_600_000 for 1 hour) or `at` for an ' +
      'absolute ISO-8601 timestamp. The prompt fires into the current session — no new ' +
      'session is created. Returns an id you can pass to schedule_cancel if you change your mind.',
    scopes: [{ resource: 'schedule:write' }],
    inputSchema: sendLaterInput,
    inputExamples: [
      { prompt: 'Re-check CI status and merge if green', delayMs: 3_600_000 },
      { prompt: 'Follow up on the deploy', at: '2026-06-23T10:00:00Z' }
    ],
    run: async (input: SendLaterInput, ctx: ToolContext) => {
      const info = scheduler.create({
        prompt: input.prompt,
        delayMs: input.delayMs,
        at: input.at,
        sessionId: ctx.sessionId
      });
      return toolResult({ id: info.id, firesAt: info.nextFireAt ?? info.spec });
    }
  };

  return [create as Tool, list as Tool, cancel as Tool, sendLater as Tool];
}

// Uniform module entry. schedule is a service module — it needs the ScheduleService; absent → none.
export const register: ToolModule = ({ scheduler }) => (scheduler ? createScheduleTools(scheduler) : []);
