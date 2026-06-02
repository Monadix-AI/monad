import type { HttpError, RequestCorrelationId } from '@monad/protocol';
import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';
import type { ConnectionState } from '#/transports/jsonrpc/index.ts';

import { timingSafeEqual } from 'node:crypto';
import { serverTiming } from '@elysiajs/server-timing';
import swagger from '@elysiajs/swagger';
import { createLogger, formatTransportCall } from '@monad/logger';
import { Elysia } from 'elysia';

import {
  consumeRequestCorrelationId,
  getRequestCorrelationId,
  mapPublicError,
  projectDirectHttpErrorResponse,
  projectHttpError
} from '#/transports/public-error.ts';

const log = createLogger('transport:http');
const requestTimings = new WeakMap<Request, number>();
type LiveFlag = boolean | (() => boolean);

function resolveLiveFlag(flag: LiveFlag | undefined): boolean {
  return typeof flag === 'function' ? flag() : flag === true;
}

function httpLogScope(path: string): { sessionId?: string; channelId?: string } {
  const sessionMatch = path.match(/^\/v1\/(?:sessions|projects)\/([^/?#]+)/);
  if (sessionMatch?.[1]) return { sessionId: decodeURIComponent(sessionMatch[1]) };
  const channelMatch = path.match(/^\/v1\/channels\/([^/?#]+)/);
  if (channelMatch?.[1]) return { channelId: decodeURIComponent(channelMatch[1]) };
  return {};
}

function logHttpCall(
  method: string,
  path: string,
  status: number,
  durationMs?: number,
  err?: unknown,
  accessLogToPrimary = false,
  requestId?: RequestCorrelationId
): void {
  const record = {
    event: 'http.request',
    method,
    path,
    status,
    durationMs,
    ...(requestId ? { requestId } : {}),
    ...httpLogScope(path),
    ...(err ? { err } : {})
  };
  // formatTransportCall allocates several ANSI-wrapped strings; skip it when the debug record
  // would be suppressed by the active level (the common case in production).
  if (status >= 500 || err) log.error(record, formatTransportCall(record));
  else if (accessLogToPrimary) log.info(record, formatTransportCall(record));
  else if (log.isLevelEnabled('debug')) log.debug(record, formatTransportCall(record));
}

function responseStatus(responseValue: unknown, setStatus: unknown): number {
  if (responseValue instanceof Response) return responseValue.status;
  return typeof setStatus === 'number' ? setStatus : 200;
}

import { createA2aController } from '#/transports/a2a/index.ts';
import { createAgentsController } from '#/transports/http/agents.ts';
import { createApprovalsController } from '#/transports/http/approvals.ts';
import { createAtomsController } from '#/transports/http/atoms.ts';
import { createAvatarCacheController } from '#/transports/http/avatar-cache.ts';
import { isBrowserRequestAllowed } from '#/transports/http/browser-guard.ts';
import { createChannelsController } from '#/transports/http/channels.ts';
import { createClarifyController } from '#/transports/http/clarify.ts';
import { createCommandsController } from '#/transports/http/commands.ts';
import { createDaemonCtlController } from '#/transports/http/daemon-ctl.ts';
import { createDelegationController } from '#/transports/http/delegation.ts';
import { createDraftAttachmentsController } from '#/transports/http/draft-attachments.ts';
import { createGraphController } from '#/transports/http/graph/controller.ts';
import { createHealthController } from '#/transports/http/health.ts';
import { createInMemoryHttpIdempotencyStore } from '#/transports/http/idempotency.ts';
import { createInboxController } from '#/transports/http/inbox.ts';
import { createIndexerController } from '#/transports/http/indexer.ts';
import { createInitController } from '#/transports/http/init.ts';
import { createInteractionsController } from '#/transports/http/interactions.ts';
import { createLawsController } from '#/transports/http/laws/controller.ts';
import { createLicensesController } from '#/transports/http/licenses/controller.ts';
import { createLocaleCatalogController, createLocaleSettingsController } from '#/transports/http/locale.ts';
import { createMcpAppController } from '#/transports/http/mcp-apps.ts';
import { createMem0DataController } from '#/transports/http/mem0-data/controller.ts';
import { createMemoryController } from '#/transports/http/memory.ts';
import { createMeshAgentController } from '#/transports/http/mesh-agent.ts';
import { createNativeAgentController } from '#/transports/http/native-agent.ts';
import { createOpenAiCompatController } from '#/transports/http/openai-compat.ts';
import { createIpRateLimiter } from '#/transports/http/rate-limit.ts';
import { createResponsesApiController } from '#/transports/http/responses-api/controller.ts';
import { createSessionsController } from '#/transports/http/sessions/controller.ts';
import { createAcpAgentSettingsController } from '#/transports/http/settings/acp-agent.ts';
import { createAppearanceSettingsController } from '#/transports/http/settings/appearance.ts';
import { createBrowserPresetSettingsController } from '#/transports/http/settings/browser-preset.ts';
import { createChannelSettingsController } from '#/transports/http/settings/channel.ts';
import { createComputerPresetSettingsController } from '#/transports/http/settings/computer-preset.ts';
import { createCredentialSettingsController } from '#/transports/http/settings/credential.ts';
import { createDeveloperSettingsController } from '#/transports/http/settings/developer.ts';
import { createHooksSettingsController } from '#/transports/http/settings/hooks.ts';
import { createSettingsImportController } from '#/transports/http/settings/import.ts';
import { createImportInventorySettingsController } from '#/transports/http/settings/import-inventory.ts';
import { createMcpServerSettingsController } from '#/transports/http/settings/mcp-server.ts';
import { createMeshAgentSettingsController } from '#/transports/http/settings/mesh-agent.ts';
import { createModelSettingsController } from '#/transports/http/settings/model.ts';
import { createNetworkSettingsController } from '#/transports/http/settings/network.ts';
import { createObscuraSettingsController } from '#/transports/http/settings/obscura.ts';
import { createOpenaiCompatSettingsController } from '#/transports/http/settings/openai-compat.ts';
import { createPeerSettingsController } from '#/transports/http/settings/peer.ts';
import { createUserProfileSettingsController } from '#/transports/http/settings/profile.ts';
import { createSandboxSettingsController } from '#/transports/http/settings/sandbox.ts';
import { createSkillsSettingsController } from '#/transports/http/settings/skills.ts';
import { createStartupSettingsController } from '#/transports/http/settings/startup.ts';
import { createToolBackendsSettingsController } from '#/transports/http/settings/tool-backends.ts';
import { createSkillsController } from '#/transports/http/skills.ts';
import { createStatsController } from '#/transports/http/stats.ts';
import { createStreamController } from '#/transports/http/stream/controller.ts';
import { createSystemController } from '#/transports/http/system.ts';
import { createToolsController } from '#/transports/http/tools.ts';
import { createUsageController } from '#/transports/http/usage.ts';
import { enrichOpenApiOperations } from '#/transports/openapi.ts';

export interface RemoteAccessConfig {
  enabled: boolean;
  token: string | null;
}

interface RemoteAccessState {
  current(): RemoteAccessConfig | undefined;
  tokenRevision(): number;
}

export interface MutableRemoteAccessState extends RemoteAccessState {
  set(next: RemoteAccessConfig | undefined): void;
}

export type RemoteAccessSource = RemoteAccessConfig | RemoteAccessState;

export interface HttpTransportOptions {
  docs?: boolean;
  developerMode?: LiveFlag;
  remoteAccess?: RemoteAccessSource;
  openaiCompatConfig?: () => Promise<{ enabled: boolean; token?: string }>;
}

const LOCALHOST = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_ORIGIN_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const CORS_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const CORS_HEADERS_ALLOWED = 'content-type, authorization, idempotency-key, x-monad-agent-id, x-monad-session-id';

// Per-remote-IP request budget (remote access only): a 60-request burst, then a
// sustained 30 req/s — generous for an API client, a backstop against a flood.
const REMOTE_RATE_LIMIT = { capacity: 60, refillPerSec: 30 };

/**
 * Never reflect an arbitrary origin together with `allow-credentials: true` — that
 * grants every cross-site page the ability to read credentialed responses.
 */
export function resolveAllowedOrigin(request: Request): string | null {
  const origin = request.headers.get('origin');
  if (!origin) return null;
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return null;
  }
  if (LOOPBACK_ORIGIN_HOSTS.has(hostname)) return origin;
  // Allow the daemon's own served host (web UI behind a TLS reverse proxy).
  const listenerHost = request.headers.get('host')?.split(':')[0];
  if (listenerHost && listenerHost === hostname) return origin;
  return null;
}

export function corsHeaders(request: Request): Record<string, string> {
  const allowed = resolveAllowedOrigin(request);
  if (!allowed) return {};
  return {
    'access-control-allow-origin': allowed,
    'access-control-allow-methods': CORS_METHODS,
    'access-control-allow-headers': CORS_HEADERS_ALLOWED,
    'access-control-allow-credentials': 'true',
    'access-control-expose-headers': 'x-monad-request-id'
  };
}

export function browserGuardErrorResponse(request: Request): Response {
  return projectDirectHttpErrorResponse(request, 403, 'FORBIDDEN', 'forbidden', false, undefined, corsHeaders(request));
}

export function remoteRateLimitErrorResponse(request: Request, retryAfterSeconds: number): Response {
  return projectDirectHttpErrorResponse(
    request,
    429,
    'RATE_LIMITED',
    'too many requests',
    true,
    { retryAfterSeconds },
    { 'retry-after': String(retryAfterSeconds), ...corsHeaders(request) }
  );
}

export function remoteUnauthorizedErrorResponse(request: Request): Response {
  return projectDirectHttpErrorResponse(
    request,
    401,
    'UNAUTHORIZED',
    'unauthorized',
    false,
    undefined,
    corsHeaders(request)
  );
}

function jsonResponse(status: number, body: HttpError, request?: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      ...(body.requestId ? { 'x-monad-request-id': body.requestId } : {}),
      ...(request ? corsHeaders(request) : {})
    }
  });
}

/**
 * Constant-time token comparison. Protects against timing side-channels that let an
 * attacker enumerate token characters by observing response latency differences.
 */
export function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  const len = Math.max(a.length, b.length, 1);
  const pa = Buffer.concat([a, Buffer.alloc(len - a.length)]);
  const pb = Buffer.concat([b, Buffer.alloc(len - b.length)]);
  return timingSafeEqual(pa, pb) && a.length === b.length;
}

export function createRemoteAccessState(initial?: RemoteAccessConfig): MutableRemoteAccessState {
  let value = initial;
  let revision = initial?.token ? 1 : 0;
  return {
    current: () => value,
    tokenRevision: () => revision,
    set: (next) => {
      if (value?.enabled !== next?.enabled || value?.token !== next?.token) revision += 1;
      value = next;
    }
  };
}

export function resolveRemoteAccessConfig(source: RemoteAccessSource | undefined): RemoteAccessConfig | undefined {
  if (!source) return undefined;
  if ('current' in source) return source.current();
  return source;
}

export function createHttpTransport(
  handlers: ReturnType<typeof createDaemonHandlers>,
  { docs = false, developerMode = false, remoteAccess, openaiCompatConfig }: HttpTransportOptions = {}
) {
  const connections = new Map<string, ConnectionState>();
  const encoder = new TextEncoder();
  const idempotencyStore = createInMemoryHttpIdempotencyStore();
  // The interactions controller + stream controller bind the SAME authority the handlers use — derived
  // from the handlers object, not a separate option, so a transport can never observe a second instance.
  const interactionService = handlers.interactions;
  // Resolve the developer-mode flag ONCE at transport creation: the primary access log reflects the
  // mode the transport started in, not a value that can flip mid-lifetime.
  const developerModeEnabled = resolveLiveFlag(developerMode);

  let app = new Elysia()
    .use(serverTiming({ enabled: developerModeEnabled }))
    .onRequest(({ request }) => {
      requestTimings.set(request, performance.now());
      getRequestCorrelationId(request);
    })
    .onAfterHandle(({ request, responseValue, set }) => {
      const t0 = requestTimings.get(request);
      const requestId = consumeRequestCorrelationId(request);
      requestTimings.delete(request);
      const status = responseStatus(responseValue, set.status);
      const url = new URL(request.url);
      logHttpCall(
        request.method,
        url.pathname,
        status,
        t0 !== undefined ? Math.round(performance.now() - t0) : undefined,
        undefined,
        developerModeEnabled,
        requestId
      );
    })
    .onError(({ code, error, request }) => {
      const t0 = requestTimings.get(request);
      const requestId = consumeRequestCorrelationId(request);
      requestTimings.delete(request);
      const url = new URL(request.url);
      const durationMs = t0 !== undefined ? Math.round(performance.now() - t0) : undefined;
      const mapped = mapPublicError(error, requestId, typeof code === 'string' ? code : undefined);
      logHttpCall(
        request.method,
        url.pathname,
        mapped.status,
        durationMs,
        error instanceof Error ? error : new Error(String(error)),
        developerModeEnabled,
        requestId
      );
      return jsonResponse(mapped.status, projectHttpError(mapped.descriptor), request);
    });

  // Runs before the remote-access token guard below; OPTIONS preflight is exempt
  // (carries no credentials and is handled by the CORS responder).
  app = app.onBeforeHandle(({ request }) => {
    if (request.method === 'OPTIONS') return;
    const remoteEnabled = resolveRemoteAccessConfig(remoteAccess)?.enabled ?? false;
    if (!isBrowserRequestAllowed(request, { remoteEnabled })) {
      return browserGuardErrorResponse(request);
    }
  }) as unknown as typeof app;

  if (docs) {
    app = app
      .onAfterHandle(({ request, responseValue }) => {
        if (new URL(request.url).pathname !== '/docs/json') return;
        return enrichOpenApiOperations(responseValue);
      })
      .use(
        swagger({
          documentation: {
            info: {
              title: 'Monad API',
              version: '1',
              description:
                'Core 4xx/5xx responses return `{ error, code, retryable, requestId, details? }`; `x-monad-request-id` matches `requestId`.'
            },
            components: {
              schemas: {
                Error: {
                  type: 'object',
                  required: ['error', 'code', 'retryable', 'requestId'],
                  properties: {
                    error: { type: 'string', description: 'Human-readable error description' },
                    code: {
                      type: 'string',
                      description: 'Machine-readable error tag (e.g. VALIDATION, NOT_FOUND, INTERNAL)'
                    },
                    retryable: { type: 'boolean', description: 'Whether retrying the request may succeed' },
                    requestId: { type: 'string', pattern: '^req_', description: 'Request correlation identifier' },
                    details: { type: 'object', description: 'Bounded safe error details', additionalProperties: true }
                  }
                }
              },
              headers: {
                MonadRequestId: {
                  description: 'Request correlation identifier, matching the error body requestId',
                  schema: { type: 'string', pattern: '^req_' }
                }
              }
            }
          },
          provider: 'scalar',
          scalarConfig: { theme: 'purple' },
          path: '/docs'
        })
      );
  }

  // Always handle CORS for loopback origins (localhost dev, direct-connect web UI).
  // resolveAllowedOrigin only allows loopback or same-host — never reflects arbitrary origins.
  app = app
    .options('/*', ({ request }) => {
      const headers: Record<string, string> = {
        'access-control-allow-methods': CORS_METHODS,
        'access-control-allow-headers': CORS_HEADERS_ALLOWED,
        ...corsHeaders(request)
      };
      return new Response(null, { status: 204, headers });
    })
    .onAfterHandle(({ request, set }) => {
      const allowed = resolveAllowedOrigin(request);
      if (!allowed) return;
      set.headers['access-control-allow-origin'] = allowed;
      set.headers['access-control-allow-methods'] = CORS_METHODS;
      set.headers['access-control-allow-headers'] = CORS_HEADERS_ALLOWED;
      set.headers['access-control-allow-credentials'] = 'true';
      set.headers['access-control-expose-headers'] = 'x-monad-request-id';
    }) as unknown as typeof app;

  // Cast through unknown to satisfy Elysia's route-tracking generics — the final return type is what matters.
  if (remoteAccess) {
    const rateLimiter = createIpRateLimiter(REMOTE_RATE_LIMIT);
    const guarded = app
      // Auth guard: unix-socket and localhost always pass; remote requests need Bearer.
      .onBeforeHandle(({ request, server }) => {
        const ra = resolveRemoteAccessConfig(remoteAccess);
        if (!ra?.enabled) return;

        const ip = server?.requestIP(request);
        // No peer IP → Unix socket (filesystem-permission gated) — trust without token.
        if (!ip) return;
        const addr = ip.address;
        if (LOCALHOST.has(addr)) return;

        // Per-IP rate limit for remote peers (reject floods before the token compare).
        const retryAfter = rateLimiter.allow(addr);
        if (retryAfter !== null) {
          return remoteRateLimitErrorResponse(request, retryAfter);
        }

        const authHeader = request.headers.get('authorization') ?? '';
        const expected = ra.token ? `Bearer ${ra.token}` : null;
        if (!expected || !tokenMatches(authHeader, expected)) {
          return remoteUnauthorizedErrorResponse(request);
        }
      });
    app = guarded as unknown as typeof app;
  }

  return app
    .use(createHealthController(handlers))
    .use(createAvatarCacheController(handlers))
    .use(createA2aController(handlers))
    .group('/openai', (g) => {
      const compatConfig = openaiCompatConfig ?? (() => Promise.resolve({ enabled: false }));
      return g
        .use(createOpenAiCompatController(handlers, encoder, compatConfig))
        .use(createResponsesApiController(handlers, encoder, compatConfig));
    })
    .group('/v1', (v1) =>
      v1
        .use(createInitController(handlers))
        .use(createAgentsController(handlers))
        .use(createChannelsController(handlers, idempotencyStore))
        .use(createSessionsController(handlers, encoder, idempotencyStore))
        .use(createUsageController(handlers))
        .use(createStatsController(handlers))
        .use(createIndexerController(handlers))
        .use(createToolsController(handlers))
        .use(createApprovalsController(handlers))
        .use(createClarifyController(handlers))
        .use(createDelegationController(handlers))
        .use(createDraftAttachmentsController(handlers))
        .use(createSkillsController(handlers))
        .use(createCommandsController(handlers))
        .use(createLicensesController(handlers))
        .use(createGraphController(handlers))
        .use(createMem0DataController(handlers))
        .use(createLawsController(handlers))
        .use(createMemoryController(handlers))
        .use(createAtomsController(handlers))
        .use(createInboxController(handlers))
        .use(createInteractionsController(interactionService))
        .use(createMcpAppController())
        .use(createNativeAgentController(handlers))
        .use(createMeshAgentController(handlers))
        .use(createMeshAgentSettingsController(handlers))
        .use(createLocaleCatalogController(handlers))
        .use(createSystemController(handlers))
        .group('/settings', (settings) =>
          settings
            .use(createCredentialSettingsController(handlers))
            .use(createModelSettingsController(handlers))
            .use(createChannelSettingsController(handlers))
            .use(createPeerSettingsController(handlers))
            .use(createAcpAgentSettingsController(handlers))
            .use(createMcpServerSettingsController(handlers))
            .use(createObscuraSettingsController(handlers))
            .use(createBrowserPresetSettingsController(handlers))
            .use(createComputerPresetSettingsController(handlers))
            .use(createOpenaiCompatSettingsController(handlers))
            .use(createNetworkSettingsController(handlers))
            .use(createAppearanceSettingsController(handlers))
            .use(createToolBackendsSettingsController(handlers))
            .use(createSandboxSettingsController(handlers))
            .use(createUserProfileSettingsController(handlers))
            .use(createDeveloperSettingsController(handlers))
            .use(createStartupSettingsController(handlers))
            .use(createHooksSettingsController(handlers))
            .use(createSettingsImportController(handlers))
            .use(createImportInventorySettingsController(handlers))
            .use(createLocaleSettingsController(handlers))
            .use(createSkillsSettingsController(handlers))
        )
        .use(
          createStreamController(handlers, connections, () => resolveRemoteAccessConfig(remoteAccess)?.enabled ?? false)
        )
        .use(createDaemonCtlController())
    );
}
