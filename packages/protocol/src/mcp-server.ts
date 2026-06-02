import { z } from 'zod';

import { sessionIdSchema } from './ids.ts';
import { httpsUrlSchema, httpUrlSchema } from './url.ts';

const configuredSecretSchema = z.object({ configured: z.boolean() }).strict();
const secretUpdateSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('replace'), value: z.string().min(1) }).strict(),
  z.object({ action: z.literal('remove') }).strict()
]);

const mcpTrustViewSchema = z.object({
  autoApproveTools: z.array(z.string()).default([]),
  pinnedToolHash: z.string().optional(),
  hostEscape: z.boolean().default(false)
});

const mcpStdioViewSchema = z.object({
  name: z.string().min(1),
  transport: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  requestTimeoutMs: z.number().int().positive().optional(),
  enabled: z.boolean(),
  trust: mcpTrustViewSchema
});

const mcpHttpAuthViewSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }),
  z.object({ mode: z.literal('bearer'), token: configuredSecretSchema }),
  z.object({ mode: z.literal('headers'), headers: z.record(z.string(), configuredSecretSchema) }),
  z.object({
    mode: z.literal('oauth'),
    clientId: z.string().optional(),
    scopes: z.array(z.string()).default([]),
    flow: z.enum(['loopback', 'device']).default('loopback')
  })
]);

const mcpHttpViewSchema = z.object({
  name: z.string().min(1),
  transport: z.literal('http'),
  url: httpUrlSchema,
  auth: mcpHttpAuthViewSchema,
  headers: z.record(z.string(), configuredSecretSchema).optional(),
  oauth: z
    .object({
      clientId: z.string().optional(),
      accessToken: configuredSecretSchema,
      refreshToken: configuredSecretSchema,
      expiresAt: z.number().optional(),
      tokenEndpoint: httpUrlSchema,
      resource: z.string().url()
    })
    .strict()
    .optional(),
  requestTimeoutMs: z.number().int().positive().optional(),
  enabled: z.boolean(),
  trust: mcpTrustViewSchema
});

export const mcpServerViewSchema = z.discriminatedUnion('transport', [mcpStdioViewSchema, mcpHttpViewSchema]);
export type McpServerView = z.infer<typeof mcpServerViewSchema>;

export const listMcpServersResponseSchema = z.object({ servers: z.array(mcpServerViewSchema) });
export type ListMcpServersResponse = z.infer<typeof listMcpServersResponseSchema>;

export const getMcpServerResponseSchema = z.object({ server: mcpServerViewSchema });
export type GetMcpServerResponse = z.infer<typeof getMcpServerResponseSchema>;

const mcpHttpAuthWriteSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }).strict(),
  z.object({ mode: z.literal('bearer'), token: secretUpdateSchema.optional() }).strict(),
  z.object({ mode: z.literal('headers'), headers: z.record(z.string(), secretUpdateSchema) }).strict(),
  z
    .object({
      mode: z.literal('oauth'),
      clientId: z.string().optional(),
      scopes: z.array(z.string()).default([]),
      flow: z.enum(['loopback', 'device']).default('loopback')
    })
    .strict()
]);

export const mcpServerWriteSchema = z.discriminatedUnion('transport', [
  mcpStdioViewSchema,
  z.object({
    name: z.string().min(1),
    transport: z.literal('http'),
    url: httpUrlSchema,
    auth: mcpHttpAuthWriteSchema,
    headers: z.record(z.string(), secretUpdateSchema).optional(),
    oauth: z
      .object({ action: z.literal('remove') })
      .strict()
      .optional(),
    requestTimeoutMs: z.number().int().positive().optional(),
    enabled: z.boolean(),
    trust: mcpTrustViewSchema
  })
]);
export type McpServerWrite = z.infer<typeof mcpServerWriteSchema>;

export const upsertMcpServerRequestSchema = z.object({ server: mcpServerWriteSchema });
export type UpsertMcpServerRequest = z.infer<typeof upsertMcpServerRequestSchema>;

export const setMcpServerEnabledRequestSchema = z.object({ enabled: z.boolean() });
export type SetMcpServerEnabledRequest = z.infer<typeof setMcpServerEnabledRequestSchema>;

// Distinct from the SYSTEM MCP servers above (config.json, boot-once): a registry-style server
// (npx/uvx, or a remote url) installed as a file atom under atoms/mcp/ connects live on the next
// rediscovery sweep — no restart. Write-only credential operations persist directly in that file.

export const installMcpAtomRequestSchema = z.object({
  server: z.union([mcpServerWriteSchema, mcpServerViewSchema]),
  /** Caller asserts consent after seeing the command/url (default-deny without it). */
  consent: z.boolean().default(false)
});
export type InstallMcpAtomRequest = z.infer<typeof installMcpAtomRequestSchema>;

export const installMcpAtomResponseSchema = z.object({
  name: z.string(),
  needsConsent: z.boolean().optional(),
  warnings: z.array(z.string()).default([])
});
export type InstallMcpAtomResponse = z.infer<typeof installMcpAtomResponseSchema>;

// Install a PREBUILT BINARY MCP server from a GitHub release (platform/arch asset + mandatory
// SHA-256) into atoms/mcp/<name>/bin/ — hot, like the registry install above. Reuses the atom
// install response.
export const installMcpBinaryRequestSchema = z.object({
  name: z.string(),
  owner: z.string().min(1),
  repo: z.string().min(1),
  tag: z.string().min(1),
  /** Hex SHA-256 of the release asset. Optional: when omitted, the release's SHA256SUMS asset is
   *  used; if neither is available the install aborts (a binary is never run unverified). */
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'expected a 64-char hex sha256')
    .optional(),
  /** Args passed to the binary when the agent connects (e.g. ["stdio"]). */
  args: z.array(z.string()).optional(),
  /** Executable name inside an archive (defaults to the repo-name heuristic). */
  binName: z.string().optional(),
  autoApproveTools: z.array(z.string()).default([]),
  consent: z.boolean().default(false)
});
export type InstallMcpBinaryRequest = z.infer<typeof installMcpBinaryRequestSchema>;

export const installedMcpAtomSchema = z.object({
  name: z.string(),
  transport: z.enum(['stdio', 'http']),
  command: z.string().optional(),
  url: httpUrlSchema.optional(),
  enabled: z.boolean().default(true)
});
export type InstalledMcpAtom = z.infer<typeof installedMcpAtomSchema>;

export const listInstalledMcpAtomsResponseSchema = z.object({ servers: z.array(installedMcpAtomSchema) });
export type ListInstalledMcpAtomsResponse = z.infer<typeof listInstalledMcpAtomsResponseSchema>;

export const getInstalledMcpAtomResponseSchema = z.object({ server: installedMcpAtomSchema });
export type GetInstalledMcpAtomResponse = z.infer<typeof getInstalledMcpAtomResponseSchema>;

// Runtime connection health for every MCP server the daemon currently knows — config.json
// servers + synthesized presets (browser/computer), file/pack atoms, and the obscura preset. Unlike
// the config view above, this reflects the LIVE connection: disabled / starting / ready / failed, with
// the advertised tool set for ready servers. Read-only; the daemon derives it from its open
// connections + current config.
export const mcpServerStatusSchema = z.object({
  name: z.string(),
  /** Where the server is declared: config.json, a synthesized preset, a file/pack atom, or obscura. */
  source: z.enum(['config', 'preset', 'file', 'obscura']),
  transport: z.enum(['stdio', 'http']).optional(),
  /** ready = handshake ok + tools registered; starting = handshake in progress; disabled =
   *  `enabled:false`; failed = enabled but startup failed (handshake error, pin mismatch, or url
   *  deduped against another server). */
  state: z.enum(['ready', 'starting', 'disabled', 'failed']),
  error: z.string().optional(),
  retryAttempt: z.number().int().nonnegative().optional(),
  nextRetryAt: z.string().datetime().optional(),
  protocolVersion: z.string().optional(),
  protocolEra: z.string().optional(),
  toolCount: z.number().int().nonnegative(),
  tools: z.array(z.string()),
  tasks: z
    .object({
      supported: z.boolean(),
      active: z.number().int().nonnegative(),
      queued: z.number().int().nonnegative(),
      started: z.number().int().nonnegative(),
      completed: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      cancelled: z.number().int().nonnegative(),
      recovered: z.number().int().nonnegative(),
      retries: z.number().int().nonnegative(),
      pendingDeliveries: z.number().int().nonnegative(),
      averageDurationMs: z.number().nonnegative()
    })
    .optional()
});
export type McpServerStatus = z.infer<typeof mcpServerStatusSchema>;

export const listMcpServerStatusResponseSchema = z.object({ servers: z.array(mcpServerStatusSchema) });
export type ListMcpServerStatusResponse = z.infer<typeof listMcpServerStatusResponseSchema>;

export const mcpTaskViewSchema = z.object({
  server: z.string(),
  taskId: z.string(),
  toolName: z.string(),
  sessionId: z.string().optional(),
  toolCallId: z.string().optional(),
  status: z.enum(['working', 'input_required', 'completed', 'failed', 'cancelled']),
  statusMessage: z.string().optional(),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
  observedAt: z.string(),
  recoveredAt: z.string().optional(),
  deliveryPending: z.boolean().optional(),
  cancelRequestedAt: z.string().optional()
});
export type McpTaskView = z.infer<typeof mcpTaskViewSchema>;

export const getMcpTaskResponseSchema = z.object({ task: mcpTaskViewSchema });
export type GetMcpTaskResponse = z.infer<typeof getMcpTaskResponseSchema>;

export const mcpAppRpcRequestSchema = z.discriminatedUnion('method', [
  z
    .object({
      method: z.literal('tools/call'),
      params: z
        .object({
          name: z.string().min(1).max(128),
          arguments: z.record(z.string(), z.unknown()).optional()
        })
        .strict()
    })
    .strict(),
  z
    .object({
      method: z.literal('resources/read'),
      params: z.object({ uri: z.string().min(1).max(2048) }).strict()
    })
    .strict()
]);
export type McpAppRpcRequest = z.infer<typeof mcpAppRpcRequestSchema>;

export const mcpAppRpcResponseSchema = z.object({ result: z.unknown() });
export type McpAppRpcResponse = z.infer<typeof mcpAppRpcResponseSchema>;

export const mcpAppCapabilityRequestSchema = z
  .object({
    bridgeId: z.string().uuid(),
    sessionId: sessionIdSchema,
    revision: z.string().min(1).max(128).optional()
  })
  .strict();
export type McpAppCapabilityRequest = z.infer<typeof mcpAppCapabilityRequestSchema>;

export const mcpAppCapabilityResponseSchema = z
  .object({
    token: z
      .string()
      .length(64)
      .regex(/^[a-f0-9]+$/),
    expiresAt: z.string().datetime()
  })
  .strict();
export type McpAppCapabilityResponse = z.infer<typeof mcpAppCapabilityResponseSchema>;

export const mcpAppViewRequestSchema = mcpAppCapabilityRequestSchema.omit({ revision: true }).extend({
  afterRevision: z.string().max(128).optional()
});
export type McpAppViewRequest = z.infer<typeof mcpAppViewRequestSchema>;

export const mcpAppViewSchema = z
  .object({
    resourceUri: z.string().min(1).max(2048),
    html: z.string(),
    revision: z.string().min(1).max(128),
    csp: z.record(z.string(), z.unknown()).optional(),
    permissions: z.record(z.string(), z.unknown()).optional()
  })
  .strict();
export type McpAppView = z.infer<typeof mcpAppViewSchema>;

export const mcpAppViewResponseSchema = z
  .object({
    changed: z.boolean(),
    view: mcpAppViewSchema.optional()
  })
  .strict();
export type McpAppViewResponse = z.infer<typeof mcpAppViewResponseSchema>;

export const mcpAppCapabilityRevokeResponseSchema = z.object({ revoked: z.boolean() }).strict();
export type McpAppCapabilityRevokeResponse = z.infer<typeof mcpAppCapabilityRevokeResponseSchema>;

// A curated directory of popular MCP servers the daemon ships, for one-click "add from catalog" in
// the UI/CLI. An entry carries enough to pre-fill the add form; the user reviews (and fills any
// `env` secret refs) before saving — nothing connects without an explicit upsert.
export const mcpCatalogEntrySchema = z.object({
  /** Stable id + default server name (e.g. 'filesystem'). */
  id: z.string(),
  name: z.string(),
  description: z.string(),
  /** Optional docs/homepage link shown in the picker. */
  homepage: httpsUrlSchema.optional(),
  transport: z.enum(['stdio', 'http']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: httpUrlSchema.optional(),
  /** Env var names the server needs (e.g. 'GITHUB_TOKEN'); the form pre-fills `${env:NAME}` refs. */
  env: z.array(z.string()).default([])
});
export type McpCatalogEntry = z.infer<typeof mcpCatalogEntrySchema>;

export const listMcpCatalogResponseSchema = z.object({ entries: z.array(mcpCatalogEntrySchema) });
export type ListMcpCatalogResponse = z.infer<typeof listMcpCatalogResponseSchema>;
