// HTTP contract wiring only. The shapes themselves are schema-first definitions
// in ids.ts / domain.ts / control.ts; this file composes them into endpoint
// contracts (params/query/body/headers/response) plus query-string coercion.

import { z } from 'zod';

import { getA2aAgentStatusResponseSchema } from './a2a.ts';
import { agentCredentialErrorResponseSchema } from './agent-credential.ts';
import {
  approvalMutationResponseSchema,
  clearApprovalsRequestSchema,
  listApprovalsQuerySchema,
  listApprovalsResponseSchema,
  listPendingApprovalsQuerySchema,
  listPendingApprovalsResponseSchema,
  revokeApprovalRequestSchema
} from './approvals.ts';
import { browserPresetResponseSchema, setBrowserPresetRequestSchema } from './browser-preset.ts';
import { commandsListQuerySchema, commandsListResponseSchema } from './command.ts';
import { computerPresetResponseSchema, setComputerPresetRequestSchema } from './computer-preset.ts';
import { getGraphResponseSchema } from './graph.ts';
import { agentIdSchema, projectIdSchema, projectMemberIdSchema, sessionIdSchema } from './ids.ts';
import {
  inboxSummarySchema,
  listInboxQuerySchema,
  listInboxResponseSchema,
  listMentionInboxQuerySchema,
  listMentionInboxResponseSchema,
  markAllInboxReadResponseSchema,
  markInboxReadRequestSchema,
  markInboxReadResponseSchema,
  markInboxUnreadRequestSchema,
  markInboxUnreadResponseSchema
} from './inbox.ts';
import { getLicensesResponseSchema } from './licenses.ts';
import { installMcpAtomRequestSchema, installMcpAtomResponseSchema } from './mcp-server.ts';
import { getMem0DataResponseSchema } from './mem0-data.ts';
import { getLawsResponseSchema, optionalMemoryScopeQuerySchema } from './memory.ts';
import {
  attachmentReadResponseSchema,
  bindSessionMemberResponseSchema,
  inviteSessionMemberRequestSchema,
  listProjectRosterResponseSchema,
  listSessionMembersResponseSchema,
  nativeAgentProjectAskCancelRequestSchema,
  nativeAgentProjectAskCancelResponseSchema,
  nativeAgentProjectAskRequestSchema,
  nativeAgentProjectAskResponseSchema,
  nativeAgentProjectInboxAckRequestSchema,
  nativeAgentProjectInboxAckResponseSchema,
  nativeAgentProjectInboxRequestSchema,
  nativeAgentProjectInboxResponseSchema,
  nativeAgentProjectPlanAddRequestSchema,
  nativeAgentProjectPlanDeleteRequestSchema,
  nativeAgentProjectPlanDeleteResponseSchema,
  nativeAgentProjectPlanListResponseSchema,
  nativeAgentProjectPlanTodoResponseSchema,
  nativeAgentProjectPlanUpdateRequestSchema,
  nativeAgentProjectPostRequestSchema,
  nativeAgentProjectPostResponseSchema,
  nativeAgentProjectReadRequestSchema,
  nativeAgentProjectReadResponseSchema,
  nativeAgentReadRequestSchema,
  nativeAgentReadResponseSchema,
  nativeAgentRuntimeInfoResponseSchema,
  nativeAgentSendRequestSchema,
  nativeAgentSendResponseSchema,
  nativeAgentSessionMembersResponseSchema,
  removeSessionMemberResponseSchema,
  sessionMemberResponseSchema,
  spawnSessionMemberRequestSchema
} from './mesh-agent/index.ts';
import { obscuraStatusResponseSchema, setObscuraRequestSchema } from './obscura.ts';
import { pickDirectoryRequestSchema, pickDirectoryResponseSchema } from './pick-directory.ts';
import { publicErrorDetailsSchema, publicErrorRequestIdSchema, publicErrorRetryableSchema } from './public-error.ts';
import {
  abortSessionResponseSchema,
  branchSessionRequestSchema,
  branchSessionResponseSchema,
  clarifyRespondRequestSchema,
  clarifyRespondResponseSchema,
  createAgentRequestSchema,
  createAgentResponseSchema,
  createOperationSourceHintSchema,
  createSessionRequestSchema,
  createSessionResponseSchema,
  deleteSessionResponseSchema,
  forwardToAcpRequestSchema,
  forwardToAcpResponseSchema,
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
} from './rpc/control.ts';
import {
  consumeSessionAttentionRequestSchema,
  consumeSessionAttentionResponseSchema,
  listSessionAttentionQuerySchema,
  listSessionAttentionResponseSchema,
  reorderWorkplaceProjectRequestSchema,
  reorderWorkplaceProjectResponseSchema
} from './session-attention.ts';
import {
  addSessionPlanTodoRequestSchema,
  deleteSessionPlanTodoRequestSchema,
  deleteSessionPlanTodoResponseSchema,
  listSessionPlanResponseSchema,
  sessionPlanTodoIdSchema,
  sessionPlanTodoResponseSchema,
  updateSessionPlanTodoRequestSchema
} from './session-plan.ts';
import { appearanceSettingsSchema, setAppearanceSettingsRequestSchema } from './settings/appearance-settings.ts';
import {
  developerSettingsSchema,
  logCleanupPreviewSchema,
  logCleanupResultSchema,
  previewLogCleanupRequestSchema,
  setDeveloperSettingsRequestSchema
} from './settings/developer-settings.ts';
import { hooksSettingsResponseSchema, setHooksSettingsRequestSchema } from './settings/hooks-settings.ts';
import {
  importInventoryOpenLocationRequestSchema,
  importInventoryOpenLocationResponseSchema,
  importInventoryResponseSchema
} from './settings/import-inventory.ts';
import {
  networkSettingsSchema,
  probeNetworkRequestSchema,
  probeNetworkResponseSchema,
  setNetworkSettingsRequestSchema
} from './settings/network-settings.ts';
import { openaiCompatSettingsSchema, setOpenaiCompatRequestSchema } from './settings/openai-compat-settings.ts';
import {
  activateSandboxBackendRequestSchema,
  sandboxActivationResultSchema,
  sandboxSettingsResponseSchema,
  setSandboxSettingsRequestSchema
} from './settings/sandbox-settings.ts';
import {
  importSettingsApplyRequestSchema,
  importSettingsApplyResultSchema,
  importSettingsPreviewSchema,
  importSettingsRequestSchema
} from './settings/settings-import.ts';
import { setSkillsSettingsRequestSchema, skillsSettingsResponseSchema } from './settings/skills-settings.ts';
import {
  openStartupSettingsResponseSchema,
  setStartupSettingsRequestSchema,
  startupSettingsSchema
} from './settings/startup-settings.ts';
import { setUserProfileSettingsRequestSchema, userProfileSettingsSchema } from './settings/user-profile-settings.ts';
import { systemUpgradeStatusSchema } from './system-upgrade.ts';
import { initDockerResponseSchema, setToolBackendsRequestSchema, toolBackendsResponseSchema } from './tool-backends.ts';
import { resolveUiMessagesRequestSchema, resolveUiMessagesResponseSchema } from './ui.ts';
import {
  createProjectSessionRequestSchema,
  createProjectSessionResponseSchema,
  createWorkplaceProjectRequestSchema,
  createWorkplaceProjectResponseSchema,
  deleteWorkplaceProjectResponseSchema,
  getWorkplaceProjectResponseSchema,
  listProjectSessionsQuerySchema,
  listProjectSessionsResponseSchema,
  listWorkplaceProjectsQuerySchema,
  listWorkplaceProjectsResponseSchema,
  updateWorkplaceProjectRequestSchema,
  updateWorkplaceProjectResponseSchema
} from './workplace-project.ts';

export const httpErrorSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
  params: z.record(z.string(), z.string()).optional(),
  retryable: publicErrorRetryableSchema.optional(),
  requestId: publicErrorRequestIdSchema.optional(),
  details: publicErrorDetailsSchema.optional()
});
export type HttpError = z.infer<typeof httpErrorSchema>;

export type HttpEndpointContract = {
  params?: z.ZodTypeAny;
  query?: z.ZodTypeAny;
  body?: z.ZodTypeAny;
  headers?: z.ZodTypeAny;
  response: Record<number, z.ZodTypeAny>;
};

export function defineHttpEndpoint<const T extends HttpEndpointContract>(endpoint: T): T {
  return endpoint;
}

// HTTP query strings are all-strings; the canonical query schemas (control.ts) are strict
// (typed booleans/numbers/arrays) and shared verbatim with the RPC transports. `coercifyQuery` is the
// single edge adapter: it wraps each boolean/number/array field with a query-value preprocess so the
// SAME schema validates a query string here and a typed JSON params object over RPC — without
// loosening the canonical (RPC) schema. String/enum/id fields are left untouched, so a literal
// `?q=true` stays the string "true" rather than being coerced to a boolean.
const coerceQueryBoolean = (value: unknown) =>
  value === '' || value === undefined
    ? undefined
    : value === 'true' || value === true
      ? true
      : value === 'false' || value === false
        ? false
        : value;

const coerceQueryNumber = (value: unknown) => {
  if (value === '' || value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return value;
  const n = Number(value);
  return Number.isNaN(n) ? value : n; // leave un-numeric strings for z.number() to reject cleanly
};

const coerceQueryArray = (value: unknown) => (value === undefined || Array.isArray(value) ? value : [value]);

function unwrapSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  let base: z.ZodTypeAny = schema;
  while (base instanceof z.ZodOptional || base instanceof z.ZodDefault || base instanceof z.ZodNullable) {
    base = base.unwrap() as z.ZodTypeAny;
  }
  return base;
}

/**
 * Derive a query-string-tolerant schema from a strict canonical query schema, preserving its
 * static type so Elysia still infers precise handler param types. Forgetting to apply this on an
 * HTTP query endpoint fails loud (a `?limit=20` string fails strict `z.number()` → 400), never
 * silently — so it can't drift the way a hand-copied schema can.
 */
export function coercifyQuery<T extends z.ZodObject<z.ZodRawShape>>(schema: T): T {
  const shape = Object.fromEntries(
    Object.entries(schema.shape).map(([key, field]) => {
      const base = unwrapSchema(field as z.ZodTypeAny);
      if (base instanceof z.ZodBoolean) return [key, z.preprocess(coerceQueryBoolean, field as z.ZodTypeAny)];
      if (base instanceof z.ZodNumber) return [key, z.preprocess(coerceQueryNumber, field as z.ZodTypeAny)];
      if (base instanceof z.ZodArray) return [key, z.preprocess(coerceQueryArray, field as z.ZodTypeAny)];
      return [key, field];
    })
  );
  return z.object(shape) as unknown as T;
}

export const responseInstanceSchema = z.custom<Response>((value: unknown) => value instanceof Response);

const sessionParamsSchema = z.object({ id: sessionIdSchema });
const sessionMemberParamsSchema = z.object({ id: sessionIdSchema, memberId: z.string().min(1) });
// Shares the `:memberId` path token with the remove route so Eden Treaty keeps both verbs on one
// node; the value here is the canonical project member id, validated strictly.
const sessionMemberBindingParamsSchema = z.object({ id: sessionIdSchema, memberId: projectMemberIdSchema });
const projectParamsSchema = z.object({ id: projectIdSchema });
const agentParamsSchema = z.object({ id: agentIdSchema });

// Reusable wire type (consumed by the daemon handler + the web client), so it lives in protocol even
// though its endpoint contract is now declared inline in the indexer controller.
export const indexerStatusSchema = z.object({
  pending: z.number().int().nonnegative(),
  running: z.boolean()
});
export type IndexerStatus = z.infer<typeof indexerStatusSchema>;

export const daemonHttpContract = {
  health: {
    get: defineHttpEndpoint({
      response: { 200: getHealthResponseSchema }
    })
  },
  sessions: {
    list: defineHttpEndpoint({
      query: coercifyQuery(listSessionsQuerySchema),
      response: { 200: listSessionsResponseSchema }
    }),
    create: defineHttpEndpoint({
      body: createSessionRequestSchema,
      response: { 201: createSessionResponseSchema }
    }),
    attention: {
      list: defineHttpEndpoint({
        query: coercifyQuery(listSessionAttentionQuerySchema),
        response: { 200: listSessionAttentionResponseSchema }
      }),
      consume: defineHttpEndpoint({
        params: sessionParamsSchema,
        body: consumeSessionAttentionRequestSchema,
        response: { 200: consumeSessionAttentionResponseSchema }
      })
    },
    // Durable session plan (P0-C), human/operator-facing surface. `origin` is an optional
    // client-declared hint the controller composes into a full OperationSource server-side (same
    // pattern as `create`/`branch`) — never trusted verbatim. `sessionId`/`todoId` travel in the
    // path, never the body.
    plan: {
      list: defineHttpEndpoint({
        params: sessionParamsSchema,
        response: { 200: listSessionPlanResponseSchema, 403: httpErrorSchema, 404: httpErrorSchema }
      }),
      addTodo: defineHttpEndpoint({
        params: sessionParamsSchema,
        body: addSessionPlanTodoRequestSchema.omit({ sessionId: true }).extend({
          origin: createOperationSourceHintSchema.optional()
        }),
        response: {
          200: sessionPlanTodoResponseSchema,
          400: httpErrorSchema,
          403: httpErrorSchema,
          404: httpErrorSchema,
          409: httpErrorSchema
        }
      }),
      updateTodo: defineHttpEndpoint({
        params: sessionParamsSchema.extend({ todoId: sessionPlanTodoIdSchema }),
        body: updateSessionPlanTodoRequestSchema.omit({ sessionId: true, todoId: true }).extend({
          origin: createOperationSourceHintSchema.optional()
        }),
        response: {
          200: sessionPlanTodoResponseSchema,
          400: httpErrorSchema,
          403: httpErrorSchema,
          404: httpErrorSchema,
          409: httpErrorSchema
        }
      }),
      deleteTodo: defineHttpEndpoint({
        params: sessionParamsSchema.extend({ todoId: sessionPlanTodoIdSchema }),
        body: deleteSessionPlanTodoRequestSchema.omit({ sessionId: true, todoId: true }).extend({
          origin: createOperationSourceHintSchema.optional()
        }),
        response: {
          200: deleteSessionPlanTodoResponseSchema,
          403: httpErrorSchema,
          404: httpErrorSchema,
          409: httpErrorSchema
        }
      })
    },
    search: defineHttpEndpoint({
      query: coercifyQuery(searchSessionsRequestSchema),
      response: { 200: searchSessionsResponseSchema }
    }),
    get: defineHttpEndpoint({
      params: sessionParamsSchema,
      response: { 200: getSessionResponseSchema, 404: httpErrorSchema }
    }),
    update: defineHttpEndpoint({
      params: sessionParamsSchema,
      body: updateSessionRequestSchema,
      response: { 200: updateSessionResponseSchema, 404: httpErrorSchema, 412: httpErrorSchema }
    }),
    delete: defineHttpEndpoint({
      params: sessionParamsSchema,
      response: { 200: deleteSessionResponseSchema, 404: httpErrorSchema }
    }),
    undoDelete: defineHttpEndpoint({
      params: sessionParamsSchema,
      response: { 200: undoDeleteSessionResponseSchema, 404: httpErrorSchema }
    }),
    abort: defineHttpEndpoint({
      params: sessionParamsSchema,
      response: { 200: abortSessionResponseSchema, 404: httpErrorSchema }
    }),
    reset: defineHttpEndpoint({
      params: sessionParamsSchema,
      response: { 200: resetSessionResponseSchema, 404: httpErrorSchema }
    }),
    branch: defineHttpEndpoint({
      params: sessionParamsSchema,
      body: branchSessionRequestSchema,
      response: { 201: branchSessionResponseSchema, 404: httpErrorSchema }
    }),
    restore: defineHttpEndpoint({
      params: sessionParamsSchema,
      body: restoreSessionRequestSchema,
      response: { 200: restoreSessionResponseSchema, 404: httpErrorSchema }
    }),
    messages: defineHttpEndpoint({
      params: sessionParamsSchema,
      query: coercifyQuery(listMessagesQuerySchema),
      response: { 200: listMessagesResponseSchema, 404: httpErrorSchema }
    }),
    resolveUiMessages: defineHttpEndpoint({
      params: sessionParamsSchema,
      body: resolveUiMessagesRequestSchema,
      response: { 200: resolveUiMessagesResponseSchema }
    }),
    send: defineHttpEndpoint({
      params: sessionParamsSchema,
      body: sendMessageRequestSchema,
      headers: z.looseObject({ accept: z.string().optional() }),
      response: { 200: z.union([sendMessageResponseSchema, responseInstanceSchema]) }
    }),
    generate: defineHttpEndpoint({
      params: sessionParamsSchema,
      body: sendMessageRequestSchema,
      response: { 200: generateMessageResponseSchema }
    }),
    forwardToAcp: defineHttpEndpoint({
      params: z.object({ id: sessionIdSchema, agent: z.string().min(1) }),
      body: forwardToAcpRequestSchema,
      response: { 200: forwardToAcpResponseSchema }
    }),
    members: {
      list: defineHttpEndpoint({
        params: sessionParamsSchema,
        response: { 200: listSessionMembersResponseSchema }
      }),
      // Every ProjectMember of the session's project, not just this session's live bindings — see
      // `listProjectRosterResponseSchema`'s comment. Used to resolve/select an assignee (e.g. for
      // SessionPlan todos), which the daemon allows to be any enabled project member.
      projectRoster: defineHttpEndpoint({
        params: sessionParamsSchema,
        response: { 200: listProjectRosterResponseSchema }
      }),
      // Invites from a project memberTemplate (`{templateId}`) or spawns an ad-hoc member
      // (`{type, name, ...}`) — the daemon route branches on which shape matched.
      add: defineHttpEndpoint({
        params: sessionParamsSchema,
        body: z.union([inviteSessionMemberRequestSchema, spawnSessionMemberRequestSchema]),
        response: {
          201: sessionMemberResponseSchema,
          400: httpErrorSchema,
          403: httpErrorSchema,
          404: httpErrorSchema
        }
      }),
      // Binds an existing project member (canonical identity) into this session; idempotent on an
      // active binding, a stable 409 conflict when the binding has left.
      bind: defineHttpEndpoint({
        params: sessionMemberBindingParamsSchema,
        response: {
          200: bindSessionMemberResponseSchema,
          400: httpErrorSchema,
          403: httpErrorSchema,
          404: httpErrorSchema,
          409: httpErrorSchema
        }
      }),
      remove: defineHttpEndpoint({
        params: sessionMemberParamsSchema,
        response: { 200: removeSessionMemberResponseSchema, 403: httpErrorSchema, 404: httpErrorSchema }
      })
    }
  },
  workplace: {
    projects: {
      list: defineHttpEndpoint({
        query: coercifyQuery(listWorkplaceProjectsQuerySchema),
        response: { 200: listWorkplaceProjectsResponseSchema }
      }),
      create: defineHttpEndpoint({
        body: createWorkplaceProjectRequestSchema,
        response: { 201: createWorkplaceProjectResponseSchema }
      }),
      reorder: defineHttpEndpoint({
        body: reorderWorkplaceProjectRequestSchema,
        response: { 200: reorderWorkplaceProjectResponseSchema, 409: httpErrorSchema }
      }),
      get: defineHttpEndpoint({
        params: projectParamsSchema,
        response: { 200: getWorkplaceProjectResponseSchema, 404: httpErrorSchema }
      }),
      update: defineHttpEndpoint({
        params: projectParamsSchema,
        body: updateWorkplaceProjectRequestSchema,
        response: { 200: updateWorkplaceProjectResponseSchema, 404: httpErrorSchema, 412: httpErrorSchema }
      }),
      delete: defineHttpEndpoint({
        params: projectParamsSchema,
        response: { 200: deleteWorkplaceProjectResponseSchema, 404: httpErrorSchema }
      }),
      sessions: {
        list: defineHttpEndpoint({
          params: projectParamsSchema,
          query: coercifyQuery(listProjectSessionsQuerySchema),
          response: { 200: listProjectSessionsResponseSchema, 404: httpErrorSchema }
        }),
        create: defineHttpEndpoint({
          params: projectParamsSchema,
          body: createProjectSessionRequestSchema,
          response: { 201: createProjectSessionResponseSchema, 404: httpErrorSchema }
        })
      }
    }
  },
  inbox: {
    items: defineHttpEndpoint({
      query: coercifyQuery(listInboxQuerySchema),
      response: { 200: listInboxResponseSchema }
    }),
    summary: defineHttpEndpoint({
      response: { 200: inboxSummarySchema }
    }),
    read: defineHttpEndpoint({
      body: markInboxReadRequestSchema,
      response: { 200: markInboxReadResponseSchema }
    }),
    readAll: defineHttpEndpoint({
      response: { 200: markAllInboxReadResponseSchema }
    }),
    unread: defineHttpEndpoint({
      body: markInboxUnreadRequestSchema,
      response: { 200: markInboxUnreadResponseSchema }
    }),
    mentions: defineHttpEndpoint({
      query: coercifyQuery(listMentionInboxQuerySchema),
      response: { 200: listMentionInboxResponseSchema }
    })
  },
  agents: {
    list: defineHttpEndpoint({
      response: { 200: listAgentsResponseSchema }
    }),
    create: defineHttpEndpoint({
      body: createAgentRequestSchema,
      response: { 201: createAgentResponseSchema, 400: agentCredentialErrorResponseSchema }
    }),
    get: defineHttpEndpoint({
      params: agentParamsSchema,
      response: { 200: getAgentResponseSchema }
    }),
    update: defineHttpEndpoint({
      params: agentParamsSchema,
      body: updateAgentRequestSchema,
      response: { 200: getAgentResponseSchema, 400: agentCredentialErrorResponseSchema }
    }),
    delete: defineHttpEndpoint({
      params: agentParamsSchema,
      response: { 200: okResponseSchema }
    }),
    promptGet: defineHttpEndpoint({
      params: agentParamsSchema,
      response: { 200: getAgentPromptResponseSchema }
    }),
    promptSet: defineHttpEndpoint({
      params: agentParamsSchema,
      body: setAgentPromptRequestSchema,
      response: { 200: getAgentPromptResponseSchema }
    }),
    mcpInstall: defineHttpEndpoint({
      params: agentParamsSchema,
      body: installMcpAtomRequestSchema,
      response: { 200: installMcpAtomResponseSchema }
    }),
    a2aStatus: defineHttpEndpoint({
      params: agentParamsSchema,
      response: { 200: getA2aAgentStatusResponseSchema }
    }),
    defaultGet: defineHttpEndpoint({
      response: { 200: getDefaultAgentResponseSchema }
    }),
    defaultSet: defineHttpEndpoint({
      body: setDefaultAgentRequestSchema,
      response: { 200: okResponseSchema }
    })
  },
  obscuraSettings: {
    get: defineHttpEndpoint({ response: { 200: obscuraStatusResponseSchema } }),
    set: defineHttpEndpoint({ body: setObscuraRequestSchema, response: { 200: obscuraStatusResponseSchema } })
  },
  browserPresetSettings: {
    get: defineHttpEndpoint({ response: { 200: browserPresetResponseSchema } }),
    set: defineHttpEndpoint({ body: setBrowserPresetRequestSchema, response: { 200: browserPresetResponseSchema } })
  },
  computerPresetSettings: {
    get: defineHttpEndpoint({ response: { 200: computerPresetResponseSchema } }),
    set: defineHttpEndpoint({ body: setComputerPresetRequestSchema, response: { 200: computerPresetResponseSchema } })
  },
  openaiCompatSettings: {
    get: defineHttpEndpoint({ response: { 200: openaiCompatSettingsSchema } }),
    set: defineHttpEndpoint({ body: setOpenaiCompatRequestSchema, response: { 200: openaiCompatSettingsSchema } })
  },
  networkSettings: {
    get: defineHttpEndpoint({ response: { 200: networkSettingsSchema } }),
    set: defineHttpEndpoint({ body: setNetworkSettingsRequestSchema, response: { 200: networkSettingsSchema } }),
    probe: defineHttpEndpoint({ body: probeNetworkRequestSchema, response: { 200: probeNetworkResponseSchema } })
  },
  appearanceSettings: {
    get: defineHttpEndpoint({ response: { 200: appearanceSettingsSchema } }),
    set: defineHttpEndpoint({
      body: setAppearanceSettingsRequestSchema,
      response: { 200: appearanceSettingsSchema }
    })
  },
  toolBackendsSettings: {
    get: defineHttpEndpoint({ response: { 200: toolBackendsResponseSchema } }),
    set: defineHttpEndpoint({ body: setToolBackendsRequestSchema, response: { 200: toolBackendsResponseSchema } }),
    initDocker: defineHttpEndpoint({ response: { 200: initDockerResponseSchema } })
  },
  sandboxSettings: {
    get: defineHttpEndpoint({ response: { 200: sandboxSettingsResponseSchema } }),
    set: defineHttpEndpoint({
      body: setSandboxSettingsRequestSchema,
      response: { 200: sandboxSettingsResponseSchema }
    }),
    activate: defineHttpEndpoint({
      body: activateSandboxBackendRequestSchema,
      response: { 200: sandboxActivationResultSchema }
    })
  },
  skillsSettings: {
    get: defineHttpEndpoint({ response: { 200: skillsSettingsResponseSchema } }),
    set: defineHttpEndpoint({ body: setSkillsSettingsRequestSchema, response: { 200: skillsSettingsResponseSchema } })
  },
  settingsImport: {
    preview: defineHttpEndpoint({
      body: importSettingsRequestSchema,
      response: { 200: importSettingsPreviewSchema }
    }),
    apply: defineHttpEndpoint({
      body: importSettingsApplyRequestSchema,
      response: { 200: importSettingsApplyResultSchema }
    })
  },
  importInventory: {
    list: defineHttpEndpoint({ response: { 200: importInventoryResponseSchema } }),
    openLocation: defineHttpEndpoint({
      body: importInventoryOpenLocationRequestSchema,
      response: { 200: importInventoryOpenLocationResponseSchema }
    })
  },
  hooksSettings: {
    get: defineHttpEndpoint({ response: { 200: hooksSettingsResponseSchema } }),
    set: defineHttpEndpoint({ body: setHooksSettingsRequestSchema, response: { 200: hooksSettingsResponseSchema } })
  },
  developerSettings: {
    get: defineHttpEndpoint({ response: { 200: developerSettingsSchema } }),
    set: defineHttpEndpoint({
      body: setDeveloperSettingsRequestSchema,
      response: { 200: developerSettingsSchema }
    }),
    previewLogCleanup: defineHttpEndpoint({
      body: previewLogCleanupRequestSchema,
      response: { 200: logCleanupPreviewSchema, 429: httpErrorSchema }
    }),
    clearLogs: defineHttpEndpoint({ response: { 200: logCleanupResultSchema, 403: httpErrorSchema } })
  },
  startupSettings: {
    get: defineHttpEndpoint({ response: { 200: startupSettingsSchema } }),
    open: defineHttpEndpoint({ response: { 200: openStartupSettingsResponseSchema } }),
    set: defineHttpEndpoint({
      body: setStartupSettingsRequestSchema,
      response: { 200: startupSettingsSchema }
    })
  },
  userProfileSettings: {
    get: defineHttpEndpoint({ response: { 200: userProfileSettingsSchema } }),
    set: defineHttpEndpoint({
      body: setUserProfileSettingsRequestSchema,
      response: { 200: userProfileSettingsSchema }
    })
  },
  tools: {
    approve: defineHttpEndpoint({
      body: toolApproveRequestSchema,
      response: { 200: toolApproveResponseSchema }
    })
  },
  approvals: {
    list: defineHttpEndpoint({
      query: listApprovalsQuerySchema,
      response: { 200: listApprovalsResponseSchema }
    }),
    pending: defineHttpEndpoint({
      query: listPendingApprovalsQuerySchema,
      response: { 200: listPendingApprovalsResponseSchema }
    }),
    revoke: defineHttpEndpoint({
      body: revokeApprovalRequestSchema,
      response: { 200: approvalMutationResponseSchema }
    }),
    clear: defineHttpEndpoint({
      body: clearApprovalsRequestSchema,
      response: { 200: approvalMutationResponseSchema }
    })
  },
  clarify: {
    respond: defineHttpEndpoint({
      body: clarifyRespondRequestSchema,
      response: { 200: clarifyRespondResponseSchema }
    })
  },
  system: {
    pickDirectory: defineHttpEndpoint({
      body: pickDirectoryRequestSchema,
      response: { 200: pickDirectoryResponseSchema, 403: httpErrorSchema }
    }),
    upgradeGet: defineHttpEndpoint({
      response: { 200: systemUpgradeStatusSchema }
    }),
    upgradeStart: defineHttpEndpoint({
      response: { 202: systemUpgradeStatusSchema }
    })
  },
  skills: {
    list: defineHttpEndpoint({
      query: listSkillsQuerySchema,
      response: { 200: listSkillsResponseSchema }
    })
  },
  commands: {
    list: defineHttpEndpoint({
      query: commandsListQuerySchema,
      response: { 200: commandsListResponseSchema }
    })
  },
  licenses: {
    list: defineHttpEndpoint({
      response: { 200: getLicensesResponseSchema }
    })
  },
  graph: {
    get: defineHttpEndpoint({
      query: optionalMemoryScopeQuerySchema,
      response: { 200: getGraphResponseSchema }
    })
  },
  mem0Data: {
    get: defineHttpEndpoint({
      response: { 200: getMem0DataResponseSchema }
    })
  },
  laws: {
    get: defineHttpEndpoint({
      query: optionalMemoryScopeQuerySchema,
      response: { 200: getLawsResponseSchema }
    })
  },
  nativeAgent: {
    projectPost: defineHttpEndpoint({
      body: nativeAgentProjectPostRequestSchema,
      response: { 200: nativeAgentProjectPostResponseSchema, 403: httpErrorSchema, 404: httpErrorSchema }
    }),
    projectAsk: defineHttpEndpoint({
      body: nativeAgentProjectAskRequestSchema,
      response: { 200: nativeAgentProjectAskResponseSchema, 403: httpErrorSchema, 404: httpErrorSchema }
    }),
    projectAskCancel: defineHttpEndpoint({
      body: nativeAgentProjectAskCancelRequestSchema,
      response: { 200: nativeAgentProjectAskCancelResponseSchema, 403: httpErrorSchema, 404: httpErrorSchema }
    }),
    projectRead: defineHttpEndpoint({
      body: nativeAgentProjectReadRequestSchema,
      response: { 200: nativeAgentProjectReadResponseSchema, 403: httpErrorSchema, 404: httpErrorSchema }
    }),
    projectInbox: defineHttpEndpoint({
      body: nativeAgentProjectInboxRequestSchema,
      response: { 200: nativeAgentProjectInboxResponseSchema, 403: httpErrorSchema, 404: httpErrorSchema }
    }),
    projectInboxAck: defineHttpEndpoint({
      body: nativeAgentProjectInboxAckRequestSchema,
      response: { 200: nativeAgentProjectInboxAckResponseSchema, 403: httpErrorSchema, 404: httpErrorSchema }
    }),
    agentSend: defineHttpEndpoint({
      body: nativeAgentSendRequestSchema,
      response: { 200: nativeAgentSendResponseSchema, 403: httpErrorSchema, 404: httpErrorSchema }
    }),
    agentRead: defineHttpEndpoint({
      body: nativeAgentReadRequestSchema,
      response: { 200: nativeAgentReadResponseSchema, 403: httpErrorSchema, 404: httpErrorSchema }
    }),
    runtimeInfo: defineHttpEndpoint({
      response: { 200: nativeAgentRuntimeInfoResponseSchema, 403: httpErrorSchema, 404: httpErrorSchema }
    }),
    // Durable session plan (P0-C), managed-agent internal proxy. sessionId is never a body field —
    // derived from the bound runtime via requireManagedBinding, same as every other nativeAgent.*
    // endpoint here.
    planList: defineHttpEndpoint({
      response: { 200: nativeAgentProjectPlanListResponseSchema, 403: httpErrorSchema, 404: httpErrorSchema }
    }),
    planAdd: defineHttpEndpoint({
      body: nativeAgentProjectPlanAddRequestSchema,
      response: {
        200: nativeAgentProjectPlanTodoResponseSchema,
        400: httpErrorSchema,
        403: httpErrorSchema,
        404: httpErrorSchema,
        409: httpErrorSchema
      }
    }),
    planUpdate: defineHttpEndpoint({
      body: nativeAgentProjectPlanUpdateRequestSchema,
      response: {
        200: nativeAgentProjectPlanTodoResponseSchema,
        400: httpErrorSchema,
        403: httpErrorSchema,
        404: httpErrorSchema,
        409: httpErrorSchema
      }
    }),
    planDelete: defineHttpEndpoint({
      body: nativeAgentProjectPlanDeleteRequestSchema,
      response: {
        200: nativeAgentProjectPlanDeleteResponseSchema,
        403: httpErrorSchema,
        404: httpErrorSchema,
        409: httpErrorSchema
      }
    }),
    sessionMembers: defineHttpEndpoint({
      response: { 200: nativeAgentSessionMembersResponseSchema, 403: httpErrorSchema, 404: httpErrorSchema }
    }),
    // Client-facing wall read (GET /v1/attachments/:id). `?download=1` streams the raw file and
    // bypasses schema validation; 410 = the referenced file no longer exists.
    attachmentRead: defineHttpEndpoint({
      response: { 200: attachmentReadResponseSchema, 404: httpErrorSchema, 410: httpErrorSchema }
    })
  }
} as const;
