// The agent-facing memory tool for the built-in L1 backend (the Claude Code model: the agent reads
// and curates its own durable memory as it works). ONE tool with an `action` discriminator —
// view/record/update/delete — matching Anthropic's memory_20250818 / text_editor single-tool shape;
// a lean tool list keeps tool-choice sharp, and the action surface is backend-agnostic so the service
// can route built-in (MD file edits) vs mem0 (passive) behind it without the model ever seeing files.
//
// The injected index already tells the agent which scopes exist; it calls `view` to read a scope's
// facts, and record/update/delete to curate. Writes default to the agent's private scope; `scope:
// "global"` shares a fact across all the user's agents (use for facts about the user themselves).

import type { SessionId } from '@monad/protocol';
import type { Tool, ToolContext, ToolInputSchema } from '@/capabilities/tools/types.ts';
import type { MemoryService, MemoryToolResult, MemoryToolScope } from '@/services/memory/index.ts';

import { toolResult } from '@/capabilities/tools/types.ts';

type MemoryAction = 'view' | 'record' | 'update' | 'delete';

interface MemoryInput {
  action: MemoryAction;
  scope?: MemoryToolScope;
  fact?: string; // record / delete
  old?: string; // update: the existing fact to replace (matched by text)
  replacement?: string; // update: the new fact text
}

const ACTIONS: readonly MemoryAction[] = ['view', 'record', 'update', 'delete'];

const memoryInput: ToolInputSchema<MemoryInput> = {
  safeParse: (input) => {
    const o = (input ?? {}) as Record<string, unknown>;
    if (typeof o.action !== 'string' || !ACTIONS.includes(o.action as MemoryAction)) {
      return { success: false, error: new Error(`"action" must be one of: ${ACTIONS.join(', ')}`) };
    }
    const action = o.action as MemoryAction;
    const scope = o.scope === 'global' ? 'global' : o.scope === 'agent' ? 'agent' : undefined;
    if (action === 'record' && (typeof o.fact !== 'string' || !o.fact.trim()))
      return { success: false, error: new Error('record requires a non-empty "fact"') };
    if (action === 'delete' && (typeof o.fact !== 'string' || !o.fact.trim()))
      return { success: false, error: new Error('delete requires the "fact" text to remove') };
    if (
      action === 'update' &&
      (typeof o.old !== 'string' || !o.old.trim() || typeof o.replacement !== 'string' || !o.replacement.trim())
    )
      return { success: false, error: new Error('update requires "old" and "replacement"') };
    return {
      success: true,
      data: {
        action,
        scope,
        fact: typeof o.fact === 'string' ? o.fact : undefined,
        old: typeof o.old === 'string' ? o.old : undefined,
        replacement: typeof o.replacement === 'string' ? o.replacement : undefined
      }
    };
  },
  toJsonSchema: () => ({
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['view', 'record', 'update', 'delete'],
        description:
          'view = read your memory (omit scope to see the index of what exists; pass a scope to read its facts); ' +
          'record = add a new durable fact; update = replace an existing fact; delete = remove a fact'
      },
      scope: {
        type: 'string',
        enum: ['agent', 'global'],
        description:
          "agent (default) = private to you; global = shared across all the user's agents (use for facts about the user)"
      },
      fact: {
        type: 'string',
        description: 'For record/delete: the fact text (e.g. "User deploys with Bun, not Node")'
      },
      old: { type: 'string', description: 'For update: the existing fact text to replace (matched by content)' },
      replacement: { type: 'string', description: 'For update: the new fact text' }
    },
    required: ['action']
  })
};

export function createMemoryAgentTools(svc: MemoryService): Tool[] {
  const memory: Tool<MemoryInput, MemoryToolResult> = {
    name: 'memory',
    description:
      'Read and curate your durable, cross-session memory. Your injected index shows which scopes hold ' +
      'memory; use action "view" to read a scope, and "record"/"update"/"delete" to keep it accurate. ' +
      'Store only stable, reusable facts (preferences, tooling, conventions, identity) — not ephemeral ' +
      'task details. Use scope "global" for facts about the user, "agent" (default) for facts specific to you.',
    scopes: [{ resource: 'memory:write' }],
    inputSchema: memoryInput,
    inputExamples: [
      { action: 'view' },
      { action: 'record', fact: 'User deploys with Bun, not Node', scope: 'global' },
      { action: 'update', old: 'User is an engineer', replacement: 'User leads the platform team' },
      { action: 'delete', fact: 'User likes cheese pizza' }
    ],
    run: async (input, ctx: ToolContext) =>
      toolResult(
        await svc.memoryTool(ctx.sessionId as SessionId, input.action, {
          fact: input.fact,
          old: input.old,
          replacement: input.replacement,
          scope: input.scope
        })
      )
  };

  return [memory];
}
