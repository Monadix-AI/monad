import type { createDaemonHandlers } from '@/handlers/handlers.ts';
import type { ConnectionState } from '@/transports/jsonrpc/index.ts';

import { timingSafeEqual } from 'node:crypto';
import swagger from '@elysiajs/swagger';
import { createLogger, formatTransportCall } from '@monad/logger';
import { Elysia } from 'elysia';

import { HANDLER_ERROR_MAP, HandlerError } from '@/handlers/handler-error.ts';

const log = createLogger('transport:http');
const requestTimings = new WeakMap<Request, number>();

function logHttpCall(method: string, path: string, status: number, durationMs?: number, err?: unknown): void {
  const record = { method, path, status, durationMs, ...(err ? { err } : {}) };
  // formatTransportCall allocates several ANSI-wrapped strings; skip it when the debug record
  // would be suppressed by the active level (the common case in production).
  if (status >= 500 || err) log.error(record, formatTransportCall(record));
  else if (log.isLevelEnabled('debug')) log.debug(record, formatTransportCall(record));
}

import { createAgentsController } from '@/transports/http/agents.ts';
import { createApprovalsController } from '@/transports/http/approvals.ts';
import { createAtomsController } from '@/transports/http/atoms.ts';
import { isBrowserRequestAllowed } from '@/transports/http/browser-guard.ts';
import { createChannelsController } from '@/transports/http/channels.ts';
import { createClarifyController } from '@/transports/http/clarify.ts';
import { createCommandsController } from '@/transports/http/commands.ts';
import { createDaemonCtlController } from '@/transports/http/daemon-ctl.ts';
import { createDelegationController } from '@/transports/http/delegation.ts';
import { createGraphController } from '@/transports/http/graph/controller.ts';
import { createHealthController } from '@/transports/http/health.ts';
import { createIndexerController } from '@/transports/http/indexer.ts';
import { createInitController } from '@/transports/http/init.ts';
import { createLawsController } from '@/transports/http/laws/controller.ts';
import { createLicensesController } from '@/transports/http/licenses/controller.ts';
import { createLocaleCatalogController, createLocaleSettingsController } from '@/transports/http/locale.ts';
import { createMem0DataController } from '@/transports/http/mem0-data/controller.ts';
import { createMemoryController } from '@/transports/http/memory.ts';
import { createNativeCliController } from '@/transports/http/native-cli.ts';
import { createOpenAiCompatController } from '@/transports/http/openai-compat.ts';
import { createIpRateLimiter } from '@/transports/http/rate-limit.ts';
import { createResponsesApiController } from '@/transports/http/responses-api/controller.ts';
import { createSessionsController } from '@/transports/http/sessions/controller.ts';
import { createAcpAgentSettingsController } from '@/transports/http/settings/acp-agent.ts';
import { createBrowserPresetSettingsController } from '@/transports/http/settings/browser-preset.ts';
import { createChannelSettingsController } from '@/transports/http/settings/channel.ts';
import { createComputerPresetSettingsController } from '@/transports/http/settings/computer-preset.ts';
import { createDeveloperSettingsController } from '@/transports/http/settings/developer.ts';
import { createHooksSettingsController } from '@/transports/http/settings/hooks.ts';
import { createSettingsImportController } from '@/transports/http/settings/import.ts';
import { createMcpServerSettingsController } from '@/transports/http/settings/mcp-server.ts';
import { createModelSettingsController } from '@/transports/http/settings/model.ts';
import { createNativeCliAgentSettingsController } from '@/transports/http/settings/native-cli-agent.ts';
import { createNetworkSettingsController } from '@/transports/http/settings/network.ts';
import { createObscuraSettingsController } from '@/transports/http/settings/obscura.ts';
import { createOpenaiCompatSettingsController } from '@/transports/http/settings/openai-compat.ts';
import { createPeerSettingsController } from '@/transports/http/settings/peer.ts';
import { createSandboxSettingsController } from '@/transports/http/settings/sandbox.ts';
import { createSkillsSettingsController } from '@/transports/http/settings/skills.ts';
import { createStartupSettingsController } from '@/transports/http/settings/startup.ts';
import { createToolBackendsSettingsController } from '@/transports/http/settings/tool-backends.ts';
import { createSkillsController } from '@/transports/http/skills.ts';
import { createStatsController } from '@/transports/http/stats.ts';
import { createStreamController } from '@/transports/http/stream/controller.ts';
import { createSystemController } from '@/transports/http/system.ts';
import { createToolsController } from '@/transports/http/tools.ts';
import { createUsageController } from '@/transports/http/usage.ts';

interface RemoteAccessConfig {
  enabled: boolean;
  token: string | null;
}

export interface HttpTransportOptions {
  docs?: boolean;
  remoteAccess?: RemoteAccessConfig;
  openaiCompatConfig?: () => Promise<{ enabled: boolean; token?: string }>;
}

const LOCALHOST = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_ORIGIN_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const CORS_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const CORS_HEADERS_ALLOWED = 'content-type, authorization, x-monad-agent-id, x-monad-session-id';

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

function corsHeaders(request: Request): Record<string, string> {
  const allowed = resolveAllowedOrigin(request);
  if (!allowed) return {};
  return {
    'access-control-allow-origin': allowed,
    'access-control-allow-methods': CORS_METHODS,
    'access-control-allow-headers': CORS_HEADERS_ALLOWED,
    'access-control-allow-credentials': 'true'
  };
}

function jsonResponse(status: number, body: { error: string; code?: string }, request?: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...(request ? corsHeaders(request) : {}) }
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

export function createHttpTransport(
  handlers: ReturnType<typeof createDaemonHandlers>,
  { docs = false, remoteAccess, openaiCompatConfig }: HttpTransportOptions = {}
) {
  const connections = new Map<string, ConnectionState>();
  const encoder = new TextEncoder();

  const remoteEnabled = remoteAccess?.enabled ?? false;

  let app = new Elysia()
    .onRequest(({ request }) => {
      requestTimings.set(request, performance.now());
    })
    .onAfterHandle(({ request, responseValue }) => {
      const t0 = requestTimings.get(request);
      requestTimings.delete(request);
      const status = responseValue instanceof Response ? responseValue.status : 200;
      const url = new URL(request.url);
      logHttpCall(
        request.method,
        url.pathname,
        status,
        t0 !== undefined ? Math.round(performance.now() - t0) : undefined
      );
    })
    .onError(({ code, error, request }) => {
      const t0 = requestTimings.get(request);
      requestTimings.delete(request);
      const url = new URL(request.url);
      const durationMs = t0 !== undefined ? Math.round(performance.now() - t0) : undefined;
      if (error instanceof HandlerError) {
        const { httpStatus, httpCode } = HANDLER_ERROR_MAP[error.kind];
        logHttpCall(request.method, url.pathname, httpStatus, durationMs);
        return jsonResponse(httpStatus, { error: error.message, code: error.code ?? httpCode }, request);
      }
      // Client-shaped errors: normalize to JSON so every failure has the same envelope.
      if (code === 'NOT_FOUND') {
        logHttpCall(request.method, url.pathname, 404, durationMs);
        return jsonResponse(404, { error: 'not found', code: 'NOT_FOUND' }, request);
      }
      if (code === 'VALIDATION' || code === 'PARSE') {
        const msg = error instanceof Error ? error.message : 'validation error';
        logHttpCall(request.method, url.pathname, 400, durationMs);
        return jsonResponse(400, { error: msg, code: 'VALIDATION' }, request);
      }
      // Unhandled server fault — log with stack so nothing is silently swallowed.
      logHttpCall(
        request.method,
        url.pathname,
        500,
        durationMs,
        error instanceof Error ? error : new Error(String(error))
      );
      return jsonResponse(500, { error: 'internal server error', code: 'INTERNAL' }, request);
    });

  // Runs before the remote-access token guard below; OPTIONS preflight is exempt
  // (carries no credentials and is handled by the CORS responder).
  app = app.onBeforeHandle(({ request }) => {
    if (request.method === 'OPTIONS') return;
    if (!isBrowserRequestAllowed(request, { remoteEnabled })) {
      return jsonResponse(403, { error: 'forbidden' }, request);
    }
  }) as unknown as typeof app;

  if (docs) {
    app = app.use(
      swagger({
        documentation: {
          info: {
            title: 'Monad API',
            version: '1',
            description: 'All 4xx/5xx responses return `{ error: string, code?: string }` (httpErrorSchema).'
          },
          components: {
            schemas: {
              Error: {
                type: 'object',
                required: ['error'],
                properties: {
                  error: { type: 'string', description: 'Human-readable error description' },
                  code: {
                    type: 'string',
                    description: 'Machine-readable error tag (e.g. VALIDATION, NOT_FOUND, INTERNAL)'
                  }
                }
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
    }) as unknown as typeof app;

  // Cast through unknown to satisfy Elysia's route-tracking generics — the final return type is what matters.
  if (remoteAccess?.enabled) {
    const ra = remoteAccess;
    const rateLimiter = createIpRateLimiter(REMOTE_RATE_LIMIT);
    const guarded = app
      // Auth guard: unix-socket and localhost always pass; remote requests need Bearer.
      .onBeforeHandle(({ request, server }) => {
        const ip = server?.requestIP(request);
        // No peer IP → Unix socket (filesystem-permission gated) — trust without token.
        if (!ip) return;
        const addr = ip.address;
        if (LOCALHOST.has(addr)) return;

        // Per-IP rate limit for remote peers (reject floods before the token compare).
        const retryAfter = rateLimiter.allow(addr);
        if (retryAfter !== null) {
          return new Response('Too Many Requests', {
            status: 429,
            headers: { 'retry-after': String(retryAfter), ...corsHeaders(request) }
          });
        }

        const authHeader = request.headers.get('authorization') ?? '';
        const expected = ra.token ? `Bearer ${ra.token}` : null;
        if (!expected || !tokenMatches(authHeader, expected)) {
          return new Response('Unauthorized', { status: 401, headers: corsHeaders(request) });
        }
      });
    app = guarded as unknown as typeof app;
  }

  return app
    .use(createHealthController(handlers))
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
        .use(createChannelsController(handlers))
        .use(createSessionsController(handlers, encoder))
        .use(createUsageController(handlers))
        .use(createStatsController(handlers))
        .use(createIndexerController(handlers))
        .use(createToolsController(handlers))
        .use(createApprovalsController(handlers))
        .use(createClarifyController(handlers))
        .use(createDelegationController(handlers))
        .use(createSkillsController(handlers))
        .use(createCommandsController(handlers))
        .use(createLicensesController(handlers))
        .use(createGraphController(handlers))
        .use(createMem0DataController(handlers))
        .use(createLawsController(handlers))
        .use(createMemoryController(handlers))
        .use(createAtomsController(handlers))
        .use(createNativeCliController(handlers))
        .use(createLocaleCatalogController(handlers))
        .use(createSystemController(handlers))
        .group('/settings', (settings) =>
          settings
            .use(createModelSettingsController(handlers))
            .use(createChannelSettingsController(handlers))
            .use(createPeerSettingsController(handlers))
            .use(createAcpAgentSettingsController(handlers))
            .use(createNativeCliAgentSettingsController(handlers))
            .use(createMcpServerSettingsController(handlers))
            .use(createObscuraSettingsController(handlers))
            .use(createBrowserPresetSettingsController(handlers))
            .use(createComputerPresetSettingsController(handlers))
            .use(createOpenaiCompatSettingsController(handlers))
            .use(createNetworkSettingsController(handlers))
            .use(createToolBackendsSettingsController(handlers))
            .use(createSandboxSettingsController(handlers))
            .use(createDeveloperSettingsController(handlers))
            .use(createStartupSettingsController(handlers))
            .use(createHooksSettingsController(handlers))
            .use(createSettingsImportController(handlers))
            .use(createLocaleSettingsController(handlers))
            .use(createSkillsSettingsController(handlers))
        )
        .use(createStreamController(handlers, connections, remoteEnabled))
        .use(createDaemonCtlController())
    );
}
