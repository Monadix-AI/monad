import type { Tool, ToolContext } from '@/capabilities/tools/types.ts';

import { z } from 'zod';

import { invokeTool } from '@/capabilities/tools/invoke.ts';

export function createToolCallTool(
  getTools: () => Tool[]
): Tool<{ name: string; args: Record<string, unknown> }, unknown> {
  return {
    name: 'tool_call',
    description:
      'Execute a registered tool by name and arguments. Use after tool_search has returned the tool schema. The name must exactly match a tool name from tool_search results.',
    scopes: [{ resource: 'internal:tool-call' }],
    highRisk: true,
    gateKey: (input) => input.name,
    inputSchema: z.object({
      name: z.string().min(1).describe('Exact tool name as returned by tool_search'),
      args: z
        .record(z.string(), z.unknown())
        .default({})
        .describe('Tool arguments matching the schema from tool_search')
    }),

    async run(input, ctx: ToolContext) {
      const tool = getTools().find((t) => t.name === input.name);
      if (!tool) {
        throw new Error(`No tool named "${input.name}" is registered. Use tool_search to find available tools.`);
      }

      const result = await invokeTool(tool, input.args, {
        sessionId: ctx.sessionId,
        toolCallId: ctx.toolCallId,
        sandboxRoots: ctx.sandboxRoots,
        backends: ctx.backends,
        defaultCwd: ctx.defaultCwd,
        signal: ctx.signal,
        log: ctx.log,
        gate: ctx.gate
      });

      return result;
    }
  };
}

import type { ToolModule } from './contract.ts';
// Uniform module entry.
export const register: ToolModule<{ getTools: () => Tool[] }> = ({ getTools }) => [createToolCallTool(getTools)];
