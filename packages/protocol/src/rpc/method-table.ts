// Bottom-layer method table: the single source of truth shared by every transport.
//
// Each method declares its request/response shape decomposed the way REST needs it:
//   • `path`   — identifier fields folded into the HTTP URL, keyed by the *HTTP path
//                param name* (`id`, `credId`, `alias`). On the JSON-RPC wire these are
//                ordinary params fields, under the same names.
//   • `query`  — filter/pagination fields sent as HTTP query string (GET requests).
//                On the JSON-RPC wire these are flattened into the params object together
//                with `path` and `body`; http.ts wraps them with string-coercion for the
//                query-string transport.
//   • `body`   — the rest of the request (a ZodObject); absent on GET methods.
//   • `result` — the response.
//
// The JSON-RPC wire flattens path+query+body into one flat params object; the HTTP
// contract keeps them split (path → URL, query → query string, body → request body).
//
// What is actually *derived* from this table: the RPC params schemas (rpc-methods.ts'
// RPC_METHOD_PARAMS) and the REST verb+URL map (HTTP_ROUTES). The HTTP request/response
// *schemas* are NOT generated here — they live in http.ts's daemonHttpContract, which
// references the SAME leaf schemas (control.ts / ids.ts / …) this table does, so the two
// transports share one shape per field. Drift is caught by tests, not codegen:
// route-table-parity.test.ts (live routes == HTTP_ROUTES) and query-parity.test.ts
// (coerced HTTP query == RPC params). Settings (/v1/settings/*) are HTTP-only by design with
// no entry here; their controllers tag routes detail.tags:['http-only'] (see that test).
//
// Wire field names are unified toward the HTTP path-param names (`sessionId`→`id`,
// `agentId`→`id`, `providerId`→`id`, `credentialId`→`credId`); the daemon-side
// dispatcher and HTTP controllers absorb the rename to their internal handler params.

import type { EventType } from '../domain.ts';

import { z } from 'zod';

import {
  approvalMutationResponseSchema,
  clearApprovalsRequestSchema,
  listApprovalsQuerySchema,
  listApprovalsResponseSchema,
  revokeApprovalRequestSchema
} from '../approvals.ts';
import { commandsListQuerySchema, commandsListResponseSchema } from '../command.ts';
import { agentIdSchema, eventIdSchema, messageIdSchema, sessionIdSchema } from '../ids.ts';
import {
  getMeshAgentAuthSessionResponseSchema,
  getMeshSessionResponseSchema,
  listMeshSessionsResponseSchema,
  meshAgentApprovalResolutionRequestSchema,
  meshAgentAuthStatusResponseSchema,
  meshAgentInputRequestSchema,
  meshAgentResizeRequestSchema,
  meshAgentUsageResponseSchema,
  startMeshAgentAuthResponseSchema,
  startMeshAgentRequestSchema,
  startMeshAgentResponseSchema
} from '../mesh-agent/index.ts';
import { setSkillsSettingsRequestSchema, skillsSettingsResponseSchema } from '../settings/skills-settings.ts';
import {
  abortSessionResponseSchema,
  branchSessionRequestSchema,
  branchSessionResponseSchema,
  clarifyRespondRequestSchema,
  clarifyRespondResponseSchema,
  createAgentRequestSchema,
  createAgentResponseSchema,
  createSessionRequestSchema,
  createSessionResponseSchema,
  deleteSessionResponseSchema,
  generateMessageResponseSchema,
  getAgentPromptResponseSchema,
  getAgentResponseSchema,
  getDefaultAgentResponseSchema,
  getHealthResponseSchema,
  getSessionResponseSchema,
  listAgentsResponseSchema,
  listMessagesQuerySchema,
  listMessagesResponseSchema,
  listSessionsQuerySchema,
  listSessionsResponseSchema,
  listSkillsQuerySchema,
  listSkillsResponseSchema,
  messageGenerationFrameSchema,
  okResponseSchema,
  resetSessionResponseSchema,
  restoreSessionRequestSchema,
  restoreSessionResponseSchema,
  searchSessionsRequestSchema,
  searchSessionsResponseSchema,
  sendMessageRequestSchema,
  sendMessageResponseSchema,
  setAgentPromptRequestSchema,
  setDefaultAgentRequestSchema,
  toolApproveRequestSchema,
  toolApproveResponseSchema,
  undoDeleteSessionResponseSchema,
  updateAgentRequestSchema,
  updateSessionRequestSchema,
  updateSessionResponseSchema
} from './control.ts';

export type HttpVerb = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * REST binding for a method: the HTTP verb plus the full external URL template. The
 * template's `:param` placeholders are exactly this method's `path` keys (enforced by
 * method-table.test.ts), so verb + URL live in the table and cannot drift from the
 * controllers — apps/monad's route-table-parity test asserts the live routes match.
 * Absent ⇒ the method is RPC/stream-only (subscribe/unsubscribe), reachable only over
 * the NDJSON transports.
 */
export interface HttpRoute {
  verb: HttpVerb;
  template: string;
}

export interface MethodDef {
  /** REST binding (verb + URL template). Absent ⇒ RPC/stream-only. */
  http?: HttpRoute;
  /** Identifier fields folded into the HTTP URL path, keyed by the HTTP path-param name. */
  path?: Record<string, z.ZodTypeAny>;
  /**
   * Filter / pagination fields. On HTTP GET requests these travel as a query string;
   * http.ts wraps them with string-coercion. On the RPC wire they are flattened into
   * the params object alongside `path` fields.
   */
  query?: z.ZodObject<z.ZodRawShape>;
  /** The rest of the request body (absent on GET methods). */
  body?: z.ZodObject<z.ZodRawShape>;
  result: z.ZodTypeAny;
  /**
   * Push notifications this subscribe method may emit. Only meaningful for
   * control.subscribe — lets clients know what event types will arrive on the
   * channel without reading the implementation.
   */
  emits?: EventType[];
}

/** A method that is exposed over BOTH HTTP and all RPC transports. `http` is required. */
export type UniversalMethodDef = MethodDef & { http: HttpRoute };
/** A method that is only reachable over NDJSON transports (WS/socket/stdio). No `http` field. */
export type RpcOnlyMethodDef = Omit<MethodDef, 'http'>;

// Subscription methods reply with a synchronous ack; the real payload streams later
// as `sessions.event` notifications.
const subscribeAckSchema = z.object({ subscribed: z.literal(true) });
const emptyResultSchema = z.object({});
const messageGenerationSubscribeAckSchema = z.object({
  subscribed: z.literal(true),
  initial: z.array(messageGenerationFrameSchema)
});

const idPath = { id: sessionIdSchema };
const agentPath = { id: agentIdSchema };
const meshSessionPath = { id: z.string().min(1) };
const meshSessionScopeQuery = z.object({ transcriptTargetId: sessionIdSchema });
const meshAgentAuthScopeQuery = z.object({ controlToken: z.string().min(32) });
const meshAgentNamePath = { name: z.string().min(1) };

export const UNIVERSAL_METHODS = {
  // Intentionally unversioned — liveness probes need a stable URL across API version bumps.
  health: { http: { verb: 'GET', template: '/health' }, result: getHealthResponseSchema },

  'sessions.list': {
    http: { verb: 'GET', template: '/v1/sessions' },
    query: listSessionsQuerySchema,
    result: listSessionsResponseSchema
  },
  'sessions.get': {
    http: { verb: 'GET', template: '/v1/sessions/:id' },
    path: idPath,
    result: getSessionResponseSchema
  },
  'sessions.create': {
    http: { verb: 'POST', template: '/v1/sessions' },
    body: createSessionRequestSchema,
    result: createSessionResponseSchema
  },
  'sessions.update': {
    http: { verb: 'PATCH', template: '/v1/sessions/:id' },
    path: idPath,
    body: updateSessionRequestSchema,
    result: updateSessionResponseSchema
  },
  'sessions.delete': {
    http: { verb: 'DELETE', template: '/v1/sessions/:id' },
    path: idPath,
    result: deleteSessionResponseSchema
  },
  'sessions.undoDelete': {
    http: { verb: 'POST', template: '/v1/sessions/:id/undo-delete' },
    path: idPath,
    result: undoDeleteSessionResponseSchema
  },
  'sessions.abort': {
    http: { verb: 'POST', template: '/v1/sessions/:id/abort' },
    path: idPath,
    result: abortSessionResponseSchema
  },
  'sessions.reset': {
    http: { verb: 'POST', template: '/v1/sessions/:id/reset' },
    path: idPath,
    result: resetSessionResponseSchema
  },
  'sessions.messages': {
    http: { verb: 'GET', template: '/v1/sessions/:id/messages' },
    path: idPath,
    query: listMessagesQuerySchema,
    result: listMessagesResponseSchema
  },
  'sessions.branch': {
    http: { verb: 'POST', template: '/v1/sessions/:id/branch' },
    path: idPath,
    body: branchSessionRequestSchema,
    result: branchSessionResponseSchema
  },
  'sessions.restore': {
    http: { verb: 'POST', template: '/v1/sessions/:id/restore' },
    path: idPath,
    body: restoreSessionRequestSchema,
    result: restoreSessionResponseSchema
  },
  'sessions.search': {
    http: { verb: 'GET', template: '/v1/sessions/search' },
    query: searchSessionsRequestSchema,
    result: searchSessionsResponseSchema
  },
  // streaming: response arrives as sessions.event notifications
  'sessions.send': {
    http: { verb: 'POST', template: '/v1/sessions/:id/messages' },
    path: idPath,
    body: sendMessageRequestSchema,
    result: sendMessageResponseSchema
  },
  // block: full assistant message returned synchronously
  'sessions.generate': {
    http: { verb: 'POST', template: '/v1/sessions/:id/messages/block' },
    path: idPath,
    body: sendMessageRequestSchema,
    result: generateMessageResponseSchema
  },
  'tools.approve': {
    http: { verb: 'POST', template: '/v1/tools/approve' },
    body: toolApproveRequestSchema,
    result: toolApproveResponseSchema
  },
  'clarify.respond': {
    http: { verb: 'POST', template: '/v1/clarifications/respond' },
    body: clarifyRespondRequestSchema,
    result: clarifyRespondResponseSchema
  },
  'approvals.list': {
    http: { verb: 'GET', template: '/v1/approvals' },
    query: listApprovalsQuerySchema,
    result: listApprovalsResponseSchema
  },
  'approvals.revoke': {
    http: { verb: 'POST', template: '/v1/approvals/revoke' },
    body: revokeApprovalRequestSchema,
    result: approvalMutationResponseSchema
  },
  'approvals.clear': {
    http: { verb: 'POST', template: '/v1/approvals/clear' },
    body: clearApprovalsRequestSchema,
    result: approvalMutationResponseSchema
  },
  'skills.list': {
    http: { verb: 'GET', template: '/v1/skills' },
    query: listSkillsQuerySchema,
    result: listSkillsResponseSchema
  },
  'settings.skills.get': {
    http: { verb: 'GET', template: '/v1/settings/skills' },
    result: skillsSettingsResponseSchema
  },
  'settings.skills.set': {
    http: { verb: 'PUT', template: '/v1/settings/skills' },
    body: setSkillsSettingsRequestSchema,
    result: skillsSettingsResponseSchema
  },

  'commands.list': {
    http: { verb: 'GET', template: '/v1/commands' },
    query: commandsListQuerySchema,
    result: commandsListResponseSchema
  },

  'agents.list': { http: { verb: 'GET', template: '/v1/agents' }, result: listAgentsResponseSchema },
  'agents.get': { http: { verb: 'GET', template: '/v1/agents/:id' }, path: agentPath, result: getAgentResponseSchema },
  'agents.create': {
    http: { verb: 'POST', template: '/v1/agents' },
    body: createAgentRequestSchema,
    result: createAgentResponseSchema
  },
  'agents.update': {
    http: { verb: 'PATCH', template: '/v1/agents/:id' },
    path: agentPath,
    body: updateAgentRequestSchema,
    result: getAgentResponseSchema
  },
  'agents.delete': { http: { verb: 'DELETE', template: '/v1/agents/:id' }, path: agentPath, result: okResponseSchema },
  'agents.prompt.get': {
    http: { verb: 'GET', template: '/v1/agents/:id/prompt' },
    path: agentPath,
    result: getAgentPromptResponseSchema
  },
  'agents.prompt.set': {
    http: { verb: 'PUT', template: '/v1/agents/:id/prompt' },
    path: agentPath,
    body: setAgentPromptRequestSchema,
    result: getAgentPromptResponseSchema
  },
  'agents.default.get': {
    http: { verb: 'GET', template: '/v1/agents/default' },
    result: getDefaultAgentResponseSchema
  },
  'agents.default.set': {
    http: { verb: 'PUT', template: '/v1/agents/default' },
    body: setDefaultAgentRequestSchema,
    result: okResponseSchema
  },

  'mesh.session.start': {
    http: { verb: 'POST', template: '/v1/mesh/sessions' },
    body: startMeshAgentRequestSchema,
    result: startMeshAgentResponseSchema
  },
  'mesh.session.list': {
    http: { verb: 'GET', template: '/v1/mesh/sessions' },
    query: z.object({ transcriptTargetId: sessionIdSchema }),
    result: listMeshSessionsResponseSchema
  },
  'mesh.session.get': {
    http: { verb: 'GET', template: '/v1/mesh/sessions/:id' },
    path: meshSessionPath,
    query: meshSessionScopeQuery,
    result: getMeshSessionResponseSchema
  },
  'mesh.session.input': {
    http: { verb: 'POST', template: '/v1/mesh/sessions/:id/input' },
    path: meshSessionPath,
    query: meshSessionScopeQuery,
    body: meshAgentInputRequestSchema,
    result: okResponseSchema
  },
  'mesh.session.interrupt': {
    http: { verb: 'POST', template: '/v1/mesh/sessions/:id/interrupt' },
    path: meshSessionPath,
    query: meshSessionScopeQuery,
    result: okResponseSchema
  },
  'mesh.session.steer': {
    http: { verb: 'POST', template: '/v1/mesh/sessions/:id/steer' },
    path: meshSessionPath,
    query: meshSessionScopeQuery,
    body: meshAgentInputRequestSchema,
    result: okResponseSchema
  },
  'mesh.session.approval': {
    http: { verb: 'POST', template: '/v1/mesh/sessions/:id/approval' },
    path: meshSessionPath,
    query: meshSessionScopeQuery,
    body: meshAgentApprovalResolutionRequestSchema,
    result: okResponseSchema
  },
  'mesh.session.resize': {
    http: { verb: 'POST', template: '/v1/mesh/sessions/:id/resize' },
    path: meshSessionPath,
    query: meshSessionScopeQuery,
    body: meshAgentResizeRequestSchema,
    result: okResponseSchema
  },
  'mesh.session.stop': {
    http: { verb: 'POST', template: '/v1/mesh/sessions/:id/stop' },
    path: meshSessionPath,
    query: meshSessionScopeQuery,
    result: okResponseSchema
  },
  'mesh.agent.auth.start': {
    http: { verb: 'POST', template: '/v1/mesh/agents/:name/auth/start' },
    path: meshAgentNamePath,
    result: startMeshAgentAuthResponseSchema
  },
  'mesh.agent.auth.status': {
    http: { verb: 'GET', template: '/v1/mesh/agents/:name/auth/status' },
    path: meshAgentNamePath,
    result: meshAgentAuthStatusResponseSchema
  },
  'mesh.agent.usage': {
    http: { verb: 'GET', template: '/v1/mesh/agents/:name/usage' },
    path: meshAgentNamePath,
    result: meshAgentUsageResponseSchema
  },
  'mesh.authSession.get': {
    http: { verb: 'GET', template: '/v1/mesh/auth-sessions/:id' },
    path: meshSessionPath,
    query: meshAgentAuthScopeQuery,
    result: getMeshAgentAuthSessionResponseSchema
  },
  'mesh.authSession.input': {
    http: { verb: 'POST', template: '/v1/mesh/auth-sessions/:id/input' },
    path: meshSessionPath,
    query: meshAgentAuthScopeQuery,
    body: meshAgentInputRequestSchema,
    result: okResponseSchema
  },
  'mesh.authSession.resize': {
    http: { verb: 'POST', template: '/v1/mesh/auth-sessions/:id/resize' },
    path: meshSessionPath,
    query: meshAgentAuthScopeQuery,
    body: meshAgentResizeRequestSchema,
    result: okResponseSchema
  },
  'mesh.authSession.stop': {
    http: { verb: 'POST', template: '/v1/mesh/auth-sessions/:id/stop' },
    path: meshSessionPath,
    query: meshAgentAuthScopeQuery,
    result: okResponseSchema
  }

  // NOTE: the model/* settings surface (and the rest of /v1/settings/*) is deliberately HTTP-only —
  // settings are a management plane reached over REST, never the JSON-RPC agent-driving transports.
  // Their endpoint contracts live inline in the settings controllers; see route-table-parity's
  // HTTP_ONLY_ROUTES.
} as const satisfies Record<string, UniversalMethodDef>;

export type UniversalMethodName = keyof typeof UNIVERSAL_METHODS;

// RPC-only methods (NDJSON transports only — no HTTP binding).
// control.subscribe/unsubscribe are RPC/stream-only. Per-session generation is NOT an RPC:
// it streams over the SSE endpoint GET /v1/sessions/:id/events (see docs/internals/realtime-channels.md).

export const RPC_ONLY_METHODS = {
  // Cross-session control stream: session-list-level changes (create/update/delete/branch/restore,
  // task lifecycle) plus host interaction notifications. Lets a client keep its session list and
  // app-wide interaction presenter live without subscribing per session id.
  'control.subscribe': {
    result: subscribeAckSchema,
    emits: [
      'session.created',
      'session.updated',
      'session.deleted',
      'session.restored',
      'session.run.started',
      'session.run.completed',
      'session.run.failed',
      'session.run.cancelled',
      'session.message.created',
      'session.message.updated',
      'session.message.deleted',
      'session.message.completed',
      'session.message.failed',
      'mesh.session.connection.opened',
      'mesh.session.connection.closed',
      'task.created',
      'task.progress',
      'task.completed',
      'task.failed',
      'mcp.status_updated'
    ] satisfies EventType[]
  },
  'control.unsubscribe': { result: emptyResultSchema },

  'session.messageGeneration.subscribe': {
    path: { id: sessionIdSchema, messageId: messageIdSchema },
    query: z.object({ afterEventId: eventIdSchema.optional() }),
    result: messageGenerationSubscribeAckSchema,
    emits: [
      'session.message.delta.appended',
      'session.message.completed',
      'session.message.failed'
    ] satisfies EventType[]
  },
  'session.messageGeneration.unsubscribe': {
    path: { id: sessionIdSchema, messageId: messageIdSchema },
    result: emptyResultSchema
  }
} as const satisfies Record<string, RpcOnlyMethodDef>;

export type RpcOnlyMethodName = keyof typeof RPC_ONLY_METHODS;

// Unified view used by rpc-methods.ts and anything needing the full method set.
export const METHOD_TABLE = { ...UNIVERSAL_METHODS, ...RPC_ONLY_METHODS } as const;

export type MethodName = keyof typeof METHOD_TABLE;

/**
 * REST routes derived from the table — the single source for verb + URL. The HTTP
 * controllers still own their handler bodies, but apps/monad's route-table-parity test
 * asserts the live Elysia routes match this map exactly, so the two cannot drift.
 * Methods without an `http` binding (subscribe/unsubscribe) are absent.
 */
export const HTTP_ROUTES: { readonly [M in MethodName]?: HttpRoute } = Object.fromEntries(
  Object.entries(METHOD_TABLE)
    .filter(([, def]) => 'http' in def && def.http)
    .map(([method, def]) => [method, (def as MethodDef).http])
);
