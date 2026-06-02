import type { Client } from '@modelcontextprotocol/client';

import { z } from 'zod';

export const MCP_TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';
export const MCP_INVOCATION_ID_META_KEY = 'com.monad/invocationId';
export const RELATED_TASK_META_KEY = 'io.modelcontextprotocol/related-task';
export const TASK_RESULT_BRIDGE_META_KEY = 'com.monad/mcp-task-result';
export const MCP_PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
export const MCP_CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';

export const callToolResultSchema = z
  .object({
    resultType: z.literal('complete').optional(),
    content: z.array(z.looseObject({ type: z.string() })),
    structuredContent: z.unknown().optional(),
    isError: z.boolean().optional(),
    _meta: z.record(z.string(), z.unknown()).optional()
  })
  .loose();

const inputRequiredResultSchema = z
  .object({
    resultType: z.literal('input_required'),
    inputRequests: z.record(z.string(), z.unknown()).optional(),
    requestState: z.string().optional()
  })
  .loose();

export const taskSchema = z
  .object({
    resultType: z.enum(['task', 'complete']).optional(),
    taskId: z.string(),
    status: z.enum(['working', 'input_required', 'completed', 'failed', 'cancelled']),
    statusMessage: z.string().optional(),
    createdAt: z.string(),
    lastUpdatedAt: z.string(),
    ttlMs: z.number().int().nonnegative().nullable(),
    pollIntervalMs: z.number().int().nonnegative().optional(),
    inputRequests: z.record(z.string(), z.unknown()).optional(),
    result: z.record(z.string(), z.unknown()).optional(),
    error: z.record(z.string(), z.unknown()).optional()
  })
  .loose();

export const toolExchangeSchema = z.union([callToolResultSchema, inputRequiredResultSchema, taskSchema]);
export const completeResultSchema = z.object({ resultType: z.literal('complete') }).loose();

export type McpTask = z.infer<typeof taskSchema>;

export function tasksClientCapabilities() {
  return { [MCP_TASKS_EXTENSION]: {} };
}

export function serverSupportsTasks(client: Client): boolean {
  if (client.getProtocolEra() !== 'modern') return false;
  const extensions = client.getServerCapabilities()?.extensions;
  return !!extensions && MCP_TASKS_EXTENSION in extensions;
}
