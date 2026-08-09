import { z } from 'zod';

import { eventEnvelopeSchema } from '../domain.ts';
import { agentIdSchema, eventIdSchema, sessionIdSchema } from '../ids.ts';
import {
  clarifyRespondRequestSchema,
  clarifyRespondResponseSchema,
  toolApproveRequestSchema,
  toolApproveResponseSchema
} from '../rpc/interaction-control.ts';
import { nativeAgentManagedMcpServerSchema } from './mesh-agent-runtime-spec.ts';
import {
  meshAgentRuntimeCapabilitiesSchema,
  meshAgentRuntimeFailureSchema,
  meshAgentTurnInputSchema
} from './mesh-session-runtime.ts';

const requestIdSchema = z.string().min(1);
const cwdSchema = z.string().min(1);
const sessionParamsSchema = z.object({ sessionId: sessionIdSchema }).strict();

const initializeRequestSchema = z
  .object({
    kind: z.literal('request'),
    id: requestIdSchema,
    method: z.literal('initialize'),
    params: z.object({ protocolVersion: z.literal(1) }).strict()
  })
  .strict();

const sessionOpenRequestSchema = z
  .object({
    kind: z.literal('request'),
    id: requestIdSchema,
    method: z.literal('session/open'),
    params: z
      .object({
        agentId: agentIdSchema,
        cwd: cwdSchema,
        providerSessionRef: sessionIdSchema.optional(),
        afterEventId: eventIdSchema.optional(),
        immutableInstructions: z.string().min(1).optional(),
        mcpServers: z.array(nativeAgentManagedMcpServerSchema).optional()
      })
      .strict()
  })
  .strict();

const turnRequest = (method: 'turn/start' | 'turn/steer') =>
  z
    .object({
      kind: z.literal('request'),
      id: requestIdSchema,
      method: z.literal(method),
      params: sessionParamsSchema.extend({ input: meshAgentTurnInputSchema }).strict()
    })
    .strict();

const sessionRequest = (method: 'turn/interrupt' | 'session/close') =>
  z
    .object({
      kind: z.literal('request'),
      id: requestIdSchema,
      method: z.literal(method),
      params: sessionParamsSchema
    })
    .strict();

const approvalResolveRequestSchema = z
  .object({
    kind: z.literal('request'),
    id: requestIdSchema,
    method: z.literal('approval/resolve'),
    params: toolApproveRequestSchema.extend({ sessionId: sessionIdSchema }).strict()
  })
  .strict();

const clarifyRespondAppServerRequestSchema = z
  .object({
    kind: z.literal('request'),
    id: requestIdSchema,
    method: z.literal('clarify/respond'),
    params: clarifyRespondRequestSchema.extend({ sessionId: sessionIdSchema }).strict()
  })
  .strict();

export const monadAppServerRequestSchema = z.discriminatedUnion('method', [
  initializeRequestSchema,
  sessionOpenRequestSchema,
  turnRequest('turn/start'),
  turnRequest('turn/steer'),
  sessionRequest('turn/interrupt'),
  approvalResolveRequestSchema,
  clarifyRespondAppServerRequestSchema,
  sessionRequest('session/close')
]);
export type MonadAppServerRequest = z.infer<typeof monadAppServerRequestSchema>;

const response = <Method extends string, Result extends z.ZodType>(method: Method, result: Result) =>
  z
    .object({
      kind: z.literal('response'),
      id: requestIdSchema,
      method: z.literal(method),
      result
    })
    .strict();

const acceptedSchema = z.object({ accepted: z.literal(true) }).strict();
const okSchema = z.object({ ok: z.boolean() }).strict();

const successResponseSchema = z.union([
  response(
    'initialize',
    z
      .object({
        protocolVersion: z.literal(1),
        capabilities: meshAgentRuntimeCapabilitiesSchema.strict()
      })
      .strict()
  ),
  response('session/open', z.object({ sessionId: sessionIdSchema }).strict()),
  response('turn/start', acceptedSchema),
  response('turn/steer', acceptedSchema),
  response('turn/interrupt', okSchema),
  response('approval/resolve', toolApproveResponseSchema.strict()),
  response('clarify/respond', clarifyRespondResponseSchema),
  response('session/close', okSchema)
]);

const methodSchema = z.enum([
  'initialize',
  'session/open',
  'turn/start',
  'turn/steer',
  'turn/interrupt',
  'approval/resolve',
  'clarify/respond',
  'session/close'
]);

const errorResponseSchema = z
  .object({
    kind: z.literal('response'),
    id: requestIdSchema,
    method: methodSchema,
    error: meshAgentRuntimeFailureSchema.strict()
  })
  .strict();

export const monadAppServerResponseSchema = z.union([successResponseSchema, errorResponseSchema]);
export type MonadAppServerResponse = z.infer<typeof monadAppServerResponseSchema>;

export const monadAppServerNotificationSchema = z.discriminatedUnion('method', [
  z
    .object({
      kind: z.literal('notification'),
      method: z.literal('session/identified'),
      params: z.object({ sessionId: sessionIdSchema }).strict()
    })
    .strict(),
  z
    .object({
      kind: z.literal('notification'),
      method: z.literal('session/event'),
      params: z.object({ event: eventEnvelopeSchema }).strict()
    })
    .strict(),
  z
    .object({
      kind: z.literal('notification'),
      method: z.literal('session/error'),
      params: meshAgentRuntimeFailureSchema.strict()
    })
    .strict()
]);
export type MonadAppServerNotification = z.infer<typeof monadAppServerNotificationSchema>;

export const monadAppServerMessageSchema = z.union([
  monadAppServerRequestSchema,
  monadAppServerResponseSchema,
  monadAppServerNotificationSchema
]);
export type MonadAppServerMessage = z.infer<typeof monadAppServerMessageSchema>;
