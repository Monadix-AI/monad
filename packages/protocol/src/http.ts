// HTTP contract wiring only. The shapes themselves are schema-first definitions
// in ids.ts / domain.ts / control.ts; this file composes them into endpoint
// contracts (params/query/body/headers/response) plus query-string coercion.

import { z } from 'zod';

import { getA2aAgentStatusResponseSchema } from './a2a.ts';
import {
  approvalMutationResponseSchema,
  clearApprovalsRequestSchema,
  listApprovalsQuerySchema,
  listApprovalsResponseSchema,
  revokeApprovalRequestSchema
} from './approvals.ts';
import { browserPresetResponseSchema, setBrowserPresetRequestSchema } from './browser-preset.ts';
import { commandsListQuerySchema, commandsListResponseSchema } from './command.ts';
import { computerPresetResponseSchema, setComputerPresetRequestSchema } from './computer-preset.ts';
import {
  attachmentReadResponseSchema,
  inviteSessionMemberRequestSchema,
  listSessionMembersResponseSchema,
  nativeAgentProjectAskRequestSchema,
  nativeAgentProjectAskResponseSchema,
  nativeAgentProjectInboxAckRequestSchema,
  nativeAgentProjectInboxAckResponseSchema,
  nativeAgentProjectInboxRequestSchema,
  nativeAgentProjectInboxResponseSchema,
  nativeAgentProjectPostRequestSchema,
  nativeAgentProjectPostResponseSchema,
  nativeAgentProjectReadRequestSchema,
  nativeAgentProjectReadResponseSchema,
  nativeAgentReadRequestSchema,
  nativeAgentReadResponseSchema,
  nativeAgentRuntimeInfoResponseSchema,
  nativeAgentSendRequestSchema,
  nativeAgentSendResponseSchema,
  removeSessionMemberResponseSchema,
  sessionMemberResponseSchema,
  spawnSessionMemberRequestSchema
} from './external-agent/index.ts';
import { getGraphResponseSchema } from './graph.ts';
import { agentIdSchema, projectIdSchema, sessionIdSchema } from './ids.ts';
import { getLicensesResponseSchema } from './licenses.ts';
import { getMem0DataResponseSchema } from './mem0-data.ts';
import { getLawsResponseSchema } from './memory.ts';
import { obscuraStatusResponseSchema, setObscuraRequestSchema } from './obscura.ts';
import { pickDirectoryRequestSchema, pickDirectoryResponseSchema } from './pick-directory.ts';
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
  forwardToAcpRequestSchema,
  forwardToAcpResponseSchema,
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
} from './rpc/control.ts';
import { appearanceSettingsSchema, setAppearanceSettingsRequestSchema } from './settings/appearance-settings.ts';
import {
  capabilityInventoryOpenLocationRequestSchema,
  capabilityInventoryOpenLocationResponseSchema,
  capabilityInventoryResponseSchema
} from './settings/capability-inventory.ts';
import { developerSettingsSchema, setDeveloperSettingsRequestSchema } from './settings/developer-settings.ts';
import { hooksSettingsResponseSchema, setHooksSettingsRequestSchema } from './settings/hooks-settings.ts';
import {
  networkSettingsSchema,
  probeNetworkRequestSchema,
  probeNetworkResponseSchema,
  setNetworkSettingsRequestSchema
} from './settings/network-settings.ts';
import { openaiCompatSettingsSchema, setOpenaiCompatRequestSchema } from './settings/openai-compat-settings.ts';
import { sandboxSettingsResponseSchema, setSandboxSettingsRequestSchema } from './settings/sandbox-settings.ts';
import {
  importSettingsApplyRequestSchema,
  importSettingsApplyResultSchema,
  importSettingsPreviewSchema,
  importSettingsRequestSchema
} from './settings/settings-import.ts';
import { setSkillsSettingsRequestSchema, skillsSettingsResponseSchema } from './settings/skills-settings.ts';
import { setStartupSettingsRequestSchema, startupSettingsSchema } from './settings/startup-settings.ts';
import { setUserProfileSettingsRequestSchema, userProfileSettingsSchema } from './settings/user-profile-settings.ts';
import { systemUpgradeStatusSchema } from './system-upgrade.ts';
import { initDockerResponseSchema, setToolBackendsRequestSchema, toolBackendsResponseSchema } from './tool-backends.ts';
import {
  createProjectSessionRequestSchema,
  createProjectSessionResponseSchema,
  createWorkplaceProjectRequestSchema,
  createWorkplaceProjectResponseSchema,
  deleteWorkplaceProjectResponseSchema,
  getWorkplaceProjectResponseSchema,
  listProjectSessionsResponseSchema,
  listWorkplaceProjectsQuerySchema,
  listWorkplaceProjectsResponseSchema,
  updateWorkplaceProjectRequestSchema,
  updateWorkplaceProjectResponseSchema
} from './workplace-project.ts';

export const httpErrorSchema = z.object({
  error: z.string(),
  code: z.string().optional()
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
// (typed booleans/numbers) and shared verbatim with the RPC transports. `coercifyQuery` is the
// single edge adapter: it wraps each boolean/number field with a string→value preprocess so the
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
      return [key, field];
    })
  );
  return z.object(shape) as unknown as T;
}

export const responseInstanceSchema = z.custom<Response>((value: unknown) => value instanceof Response);

const sessionParamsSchema = z.object({ id: sessionIdSchema });
const sessionMemberParamsSchema = z.object({ id: sessionIdSchema, memberId: z.string().min(1) });
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
    search: defineHttpEndpoint({
      query: coercifyQuery(searchSessionsRequestSchema),
      response: { 200: searchSessionsResponseSchema }
    }),
    get: defineHttpEndpoint({
      params: sessionParamsSchema,
      response: { 200: getSessionResponseSchema }
    }),
    update: defineHttpEndpoint({
      params: sessionParamsSchema,
      body: updateSessionRequestSchema,
      response: { 200: updateSessionResponseSchema, 412: httpErrorSchema }
    }),
    delete: defineHttpEndpoint({
      params: sessionParamsSchema,
      response: { 200: deleteSessionResponseSchema }
    }),
    abort: defineHttpEndpoint({
      params: sessionParamsSchema,
      response: { 200: abortSessionResponseSchema }
    }),
    reset: defineHttpEndpoint({
      params: sessionParamsSchema,
      response: { 200: resetSessionResponseSchema }
    }),
    branch: defineHttpEndpoint({
      params: sessionParamsSchema,
      body: branchSessionRequestSchema,
      response: { 201: branchSessionResponseSchema }
    }),
    provenance: defineHttpEndpoint({
      params: sessionParamsSchema,
      response: { 200: getProvenanceResponseSchema }
    }),
    restore: defineHttpEndpoint({
      params: sessionParamsSchema,
      body: restoreSessionRequestSchema,
      response: { 200: restoreSessionResponseSchema }
    }),
    messages: defineHttpEndpoint({
      params: sessionParamsSchema,
      query: coercifyQuery(listMessagesQuerySchema),
      response: { 200: listMessagesResponseSchema }
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
      // Invites from a project memberTemplate (`{templateId}`) or spawns an ad-hoc member
      // (`{type, name, ...}`) — the daemon route branches on which shape matched.
      add: defineHttpEndpoint({
        params: sessionParamsSchema,
        body: z.union([inviteSessionMemberRequestSchema, spawnSessionMemberRequestSchema]),
        response: { 201: sessionMemberResponseSchema, 404: httpErrorSchema }
      }),
      remove: defineHttpEndpoint({
        params: sessionMemberParamsSchema,
        response: { 200: removeSessionMemberResponseSchema, 404: httpErrorSchema }
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
  agents: {
    list: defineHttpEndpoint({
      response: { 200: listAgentsResponseSchema }
    }),
    create: defineHttpEndpoint({
      body: createAgentRequestSchema,
      response: { 201: createAgentResponseSchema }
    }),
    get: defineHttpEndpoint({
      params: agentParamsSchema,
      response: { 200: getAgentResponseSchema }
    }),
    update: defineHttpEndpoint({
      params: agentParamsSchema,
      body: updateAgentRequestSchema,
      response: { 200: getAgentResponseSchema }
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
    set: defineHttpEndpoint({ body: setSandboxSettingsRequestSchema, response: { 200: sandboxSettingsResponseSchema } })
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
  capabilityInventory: {
    list: defineHttpEndpoint({ response: { 200: capabilityInventoryResponseSchema } }),
    openLocation: defineHttpEndpoint({
      body: capabilityInventoryOpenLocationRequestSchema,
      response: { 200: capabilityInventoryOpenLocationResponseSchema }
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
    })
  },
  startupSettings: {
    get: defineHttpEndpoint({ response: { 200: startupSettingsSchema } }),
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
    // Client-facing wall read (GET /v1/attachments/:id). `?download=1` streams the raw file and
    // bypasses schema validation; 410 = the referenced file no longer exists.
    attachmentRead: defineHttpEndpoint({
      response: { 200: attachmentReadResponseSchema, 404: httpErrorSchema, 410: httpErrorSchema }
    })
  }
} as const;
