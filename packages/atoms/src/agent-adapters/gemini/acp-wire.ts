import { z } from 'zod';

export const jsonRpcIdSchema = z.union([z.string(), z.number()]);

const jsonRpcErrorSchema = z
  .object({
    code: z.number(),
    message: z.string(),
    data: z.unknown().optional()
  })
  .catchall(z.unknown());

export const jsonRpcResponseSchema = z
  .object({
    jsonrpc: z.literal('2.0').optional(),
    id: jsonRpcIdSchema,
    result: z.unknown().optional(),
    error: jsonRpcErrorSchema.optional()
  })
  .catchall(z.unknown())
  .refine((value) => Object.hasOwn(value, 'result') || value.error !== undefined);

const contentSchema = z
  .object({
    type: z.string(),
    text: z.string().optional()
  })
  .catchall(z.unknown());

export const sessionUpdateSchema = z
  .object({
    sessionId: z.string(),
    update: z
      .object({
        sessionUpdate: z.string(),
        content: z.union([contentSchema, z.array(z.unknown())]).optional(),
        toolCallId: z.string().optional(),
        title: z.string().optional(),
        name: z.string().nullable().optional(),
        status: z.string().nullable().optional(),
        rawInput: z.unknown().optional(),
        rawOutput: z.unknown().optional()
      })
      .catchall(z.unknown())
  })
  .catchall(z.unknown());

export const sessionUpdateNotificationSchema = z
  .object({
    jsonrpc: z.literal('2.0').optional(),
    method: z.literal('session/update'),
    params: sessionUpdateSchema
  })
  .catchall(z.unknown());

const permissionOptionSchema = z
  .object({
    optionId: z.string(),
    name: z.string(),
    kind: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always'])
  })
  .catchall(z.unknown());

export const permissionRequestSchema = z
  .object({
    jsonrpc: z.literal('2.0').optional(),
    id: jsonRpcIdSchema,
    method: z.literal('session/request_permission'),
    params: z
      .object({
        sessionId: z.string(),
        toolCall: z
          .object({
            toolCallId: z.string(),
            title: z.string().nullable().optional(),
            name: z.string().nullable().optional(),
            rawInput: z.unknown().optional()
          })
          .catchall(z.unknown()),
        options: z.array(permissionOptionSchema)
      })
      .catchall(z.unknown())
  })
  .catchall(z.unknown());

export const genericRequestSchema = z
  .object({
    jsonrpc: z.literal('2.0').optional(),
    id: jsonRpcIdSchema,
    method: z.string()
  })
  .catchall(z.unknown());

export const initializeResultSchema = z
  .object({
    protocolVersion: z.number(),
    agentCapabilities: z
      .object({
        loadSession: z.boolean().optional()
      })
      .catchall(z.unknown())
      .optional()
  })
  .catchall(z.unknown());

export const newSessionResultSchema = z
  .object({
    sessionId: z.string().min(1)
  })
  .catchall(z.unknown());

export type JsonRpcId = z.infer<typeof jsonRpcIdSchema>;
export type JsonRpcResponse = z.infer<typeof jsonRpcResponseSchema>;
export type PermissionRequest = z.infer<typeof permissionRequestSchema>;
export type SessionUpdate = z.infer<typeof sessionUpdateSchema>;
