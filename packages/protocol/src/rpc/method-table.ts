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
import { commandsListResponseSchema } from '../command.ts';
import { agentIdSchema, sessionIdSchema, transcriptTargetIdSchema } from '../ids.ts';
import {
  getNativeCliAuthSessionResponseSchema,
  getNativeCliSessionResponseSchema,
  listNativeCliSessionsResponseSchema,
  nativeCliApprovalResolutionRequestSchema,
  nativeCliAuthStatusResponseSchema,
  nativeCliHistoryPageRequestSchema,
  nativeCliHistoryPageResponseSchema,
  nativeCliInputRequestSchema,
  nativeCliResizeRequestSchema,
  nativeCliUsageResponseSchema,
  startNativeCliAgentRequestSchema,
  startNativeCliAgentResponseSchema,
  startNativeCliAuthResponseSchema
} from '../native-cli-agent/index.ts';
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
  getProvenanceResponseSchema,
  getSessionResponseSchema,
  listAgentsResponseSchema,
  listMessagesQuerySchema,
  listMessagesResponseSchema,
  listSessionsQuerySchema,
  listSessionsResponseSchema,
  listSkillsQuerySchema,
  listSkillsResponseSchema,
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

const idPath = { id: sessionIdSchema };
const transcriptTargetPath = { id: transcriptTargetIdSchema };
const agentPath = { id: agentIdSchema };
const nativeCliSessionPath = { id: z.string().min(1) };
const nativeCliSessionScopeQuery = z.object({ transcriptTargetId: transcriptTargetIdSchema });
const nativeCliAuthScopeQuery = z.object({ controlToken: z.string().min(32) });
const nativeCliAgentNamePath = { name: z.string().min(1) };

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
  'sessions.provenance': {
    http: { verb: 'GET', template: '/v1/sessions/:id/provenance' },
    path: idPath,
    result: getProvenanceResponseSchema
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

  'commands.list': { http: { verb: 'GET', template: '/v1/commands' }, result: commandsListResponseSchema },

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

  'nativeCli.start': {
    http: { verb: 'POST', template: '/v1/sessions/:id/native-cli-agents/start' },
    path: idPath,
    body: startNativeCliAgentRequestSchema,
    result: startNativeCliAgentResponseSchema
  },
  'nativeCli.list': {
    http: { verb: 'GET', template: '/v1/sessions/:id/native-cli-sessions' },
    path: idPath,
    result: listNativeCliSessionsResponseSchema
  },
  'nativeCli.get': {
    http: { verb: 'GET', template: '/v1/native-cli-sessions/:id' },
    path: nativeCliSessionPath,
    query: nativeCliSessionScopeQuery,
    result: getNativeCliSessionResponseSchema
  },
  'nativeCli.input': {
    http: { verb: 'POST', template: '/v1/native-cli-sessions/:id/input' },
    path: nativeCliSessionPath,
    query: nativeCliSessionScopeQuery,
    body: nativeCliInputRequestSchema,
    result: okResponseSchema
  },
  'nativeCli.interrupt': {
    http: { verb: 'POST', template: '/v1/native-cli-sessions/:id/interrupt' },
    path: nativeCliSessionPath,
    query: nativeCliSessionScopeQuery,
    result: okResponseSchema
  },
  'nativeCli.steer': {
    http: { verb: 'POST', template: '/v1/native-cli-sessions/:id/steer' },
    path: nativeCliSessionPath,
    query: nativeCliSessionScopeQuery,
    body: nativeCliInputRequestSchema,
    result: okResponseSchema
  },
  'nativeCli.approval': {
    http: { verb: 'POST', template: '/v1/native-cli-sessions/:id/approval' },
    path: nativeCliSessionPath,
    query: nativeCliSessionScopeQuery,
    body: nativeCliApprovalResolutionRequestSchema,
    result: okResponseSchema
  },
  'nativeCli.resize': {
    http: { verb: 'POST', template: '/v1/native-cli-sessions/:id/resize' },
    path: nativeCliSessionPath,
    query: nativeCliSessionScopeQuery,
    body: nativeCliResizeRequestSchema,
    result: okResponseSchema
  },
  'nativeCli.stop': {
    http: { verb: 'POST', template: '/v1/native-cli-sessions/:id/stop' },
    path: nativeCliSessionPath,
    query: nativeCliSessionScopeQuery,
    result: okResponseSchema
  },
  'nativeCli.historyPage': {
    http: { verb: 'GET', template: '/v1/native-cli-sessions/:id/history-page' },
    path: nativeCliSessionPath,
    query: nativeCliSessionScopeQuery.merge(nativeCliHistoryPageRequestSchema),
    result: nativeCliHistoryPageResponseSchema
  },
  'nativeCli.auth.start': {
    http: { verb: 'POST', template: '/v1/native-cli-agents/:name/auth/start' },
    path: nativeCliAgentNamePath,
    result: startNativeCliAuthResponseSchema
  },
  'nativeCli.auth.status': {
    http: { verb: 'GET', template: '/v1/native-cli-agents/:name/auth/status' },
    path: nativeCliAgentNamePath,
    result: nativeCliAuthStatusResponseSchema
  },
  'nativeCli.usage': {
    http: { verb: 'GET', template: '/v1/native-cli-agents/:name/usage' },
    path: nativeCliAgentNamePath,
    result: nativeCliUsageResponseSchema
  },
  'nativeCli.auth.get': {
    http: { verb: 'GET', template: '/v1/native-cli-auth-sessions/:id' },
    path: nativeCliSessionPath,
    query: nativeCliAuthScopeQuery,
    result: getNativeCliAuthSessionResponseSchema
  },
  'nativeCli.auth.input': {
    http: { verb: 'POST', template: '/v1/native-cli-auth-sessions/:id/input' },
    path: nativeCliSessionPath,
    query: nativeCliAuthScopeQuery,
    body: nativeCliInputRequestSchema,
    result: okResponseSchema
  },
  'nativeCli.auth.resize': {
    http: { verb: 'POST', template: '/v1/native-cli-auth-sessions/:id/resize' },
    path: nativeCliSessionPath,
    query: nativeCliAuthScopeQuery,
    body: nativeCliResizeRequestSchema,
    result: okResponseSchema
  },
  'nativeCli.auth.stop': {
    http: { verb: 'POST', template: '/v1/native-cli-auth-sessions/:id/stop' },
    path: nativeCliSessionPath,
    query: nativeCliAuthScopeQuery,
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
// it streams over the SSE endpoint GET /v1/sessions/:id/events (see docs/realtime-channels.md).

export const RPC_ONLY_METHODS = {
  // Cross-session control stream: session-list-level changes (create/update/delete/branch/restore,
  // task lifecycle). Lets a client keep its session list live without subscribing per session id.
  'control.subscribe': {
    result: subscribeAckSchema,
    emits: [
      'session.created',
      'session.updated',
      'session.deleted',
      'session.branched',
      'session.restored',
      'session.stream_started',
      'session.stream_ended',
      'task.created',
      'task.progress',
      'task.completed',
      'task.failed'
    ] satisfies EventType[]
  },
  'control.unsubscribe': { result: emptyResultSchema },

  // Per-session event stream over the WS transport. Pushes the same events as the SSE endpoint
  // GET /v1/sessions/:id/events — every agent/tool/message event for that session — as
  // `sessions.event` notifications. Used by native clients (e.g. Mo) that already hold a WS
  // connection and want a single multiplexed channel instead of a parallel SSE stream.
  'session.subscribe': {
    path: transcriptTargetPath,
    result: subscribeAckSchema,
    emits: [
      'agent.message',
      'agent.token',
      'agent.reasoning',
      'agent.error',
      'message.delta',
      'message.complete',
      'tool.called',
      'tool.result',
      'tool.progress',
      'tool.approval_requested',
      'tool.approval_resolved',
      'session.stream_started',
      'session.stream_ended'
    ] satisfies EventType[]
  },
  'session.unsubscribe': { path: transcriptTargetPath, result: emptyResultSchema }
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
