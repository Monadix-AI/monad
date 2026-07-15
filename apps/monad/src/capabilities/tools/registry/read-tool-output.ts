// read_tool_output — pages back the full pre-truncation/pre-eviction bytes of an earlier tool call,
// keyed by the tool-call id spilled via AgentLoopDeps.persistRawToolOutput / ToolResultEvictionContext
// (see tool-output.ts truncateToolOutput and context/eviction.ts). Gives the model a deterministic
// recovery path — read the bytes that actually happened — instead of re-running a call that may be
// non-reproducible (a one-off query) or side-effecting (a write command).

import type { Tool, ToolContext, ToolInputSchema } from '#/capabilities/tools/types.ts';
import type { ToolModule } from './contract.ts';

import { DEFAULT_MAX_TOOL_RESULT_CHARS, truncateToolOutput } from '#/agent/loop/tool-output.ts';
import { toolResult } from '#/capabilities/tools/types.ts';

/** Read-only backend for the spill table (the daemon wires this to Store.getToolRawOutput, which is
 *  lineage-aware — a branched session can read a handle spilled by an ancestor). */
export interface RawOutputStore {
  get(sessionId: string, toolCallId: string): string | null;
}

// Re-truncate a read at the same cap as a live tool result (same source constant), so paging can't
// itself blow the window.
const MAX_READ_CHARS = DEFAULT_MAX_TOOL_RESULT_CHARS;

interface ReadToolOutputInput {
  id: string;
  offset?: number;
  limit?: number;
  grep?: string;
}

const readToolOutputInput: ToolInputSchema<ReadToolOutputInput> = {
  safeParse: (input) => {
    const o = (input ?? {}) as Record<string, unknown>;
    if (typeof o.id !== 'string' || o.id.length === 0) {
      return { success: false, error: new Error('read_tool_output requires a non-empty "id"') };
    }
    if (o.offset !== undefined && !(typeof o.offset === 'number' && Number.isFinite(o.offset) && o.offset >= 0)) {
      return { success: false, error: new Error('"offset" must be a non-negative finite number') };
    }
    if (o.limit !== undefined && !(typeof o.limit === 'number' && Number.isFinite(o.limit) && o.limit >= 0)) {
      return { success: false, error: new Error('"limit" must be a non-negative finite number') };
    }
    if (o.grep !== undefined && typeof o.grep !== 'string') {
      return { success: false, error: new Error('"grep" must be a string') };
    }
    return {
      success: true,
      data: {
        id: o.id,
        ...(o.offset !== undefined ? { offset: o.offset as number } : {}),
        ...(o.limit !== undefined ? { limit: o.limit as number } : {}),
        ...(o.grep !== undefined ? { grep: o.grep as string } : {})
      }
    };
  },
  toJsonSchema: () => ({
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The tool-call id from a "…truncated…" or "…cleared…" marker' },
      offset: { type: 'number', description: 'Character offset to start reading from (default 0)' },
      limit: { type: 'number', description: 'Max characters to return (default 24000)' },
      grep: { type: 'string', description: 'Return only lines matching this substring instead of a byte range' }
    },
    required: ['id']
  })
};

function applyGrep(text: string, needle: string): string {
  const lines = text.split('\n').filter((line) => line.includes(needle));
  return lines.length ? lines.join('\n') : `(no lines contain "${needle}")`;
}

/** Build the read_tool_output tool over a spill-table reader. */
export function createReadToolOutputTool(store: RawOutputStore): Tool[] {
  const tool: Tool<ReadToolOutputInput, { found: boolean }> = {
    name: 'read_tool_output',
    description:
      'Read back the full output of an earlier tool call that was truncated or cleared from context (see the "id" in its marker). Page with offset/limit, or filter with grep. Returns the actual bytes from that call — not a re-run.',
    scopes: [{ resource: 'tool-output:read' }],
    inputSchema: readToolOutputInput,
    inputExamples: [
      { id: 'call_abc123', offset: 0, limit: 4000 },
      { id: 'call_abc123', grep: 'Error' }
    ],
    run: async (input, ctx: ToolContext) => {
      const full = store.get(ctx.sessionId, input.id);
      if (full === null) {
        return toolResult(
          { found: false },
          { modelContent: `No spilled output found for id "${input.id}" (never truncated, or already gone).` }
        );
      }
      const sliced = input.grep
        ? applyGrep(full, input.grep)
        : full.slice(input.offset ?? 0, (input.offset ?? 0) + (input.limit ?? MAX_READ_CHARS));
      const modelContent = truncateToolOutput(sliced, MAX_READ_CHARS);
      return toolResult({ found: true }, { modelContent });
    }
  };
  return [tool];
}

// Uniform module entry. Service module — needs a spill-table reader; absent → no tool.
export const register: ToolModule = ({ rawOutputs }) => (rawOutputs ? createReadToolOutputTool(rawOutputs) : []);
