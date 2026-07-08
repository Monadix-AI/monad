import type { AgentId, SessionId } from '@monad/protocol';
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionContentPartText,
  ChatCompletionCreateParamsBase,
  ChatCompletionMessageParam
} from 'openai/resources/chat/completions';
import type { CompletionUsage } from 'openai/resources/completions';
import type { EmbeddingCreateParams } from 'openai/resources/embeddings';
import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';

import { timingSafeEqual } from 'node:crypto';
import { newId, parseEventPayload } from '@monad/protocol';
import { Elysia } from 'elysia';

import { HANDLER_ERROR_MAP, HandlerError } from '#/handlers/handler-error.ts';
import { buildSessionOrigin } from '#/handlers/session/origin.ts';
import { isInboundDelegationSession } from '#/services/inbound-approval.ts';
import { SSE_RESPONSE_HEADERS } from '#/transports/http/sessions/sse.ts';

// ── OpenAI wire types ─────────────────────────────────────────────────────────
// All openai SDK imports are type-only — erased at bundle time.

// Vendor extension carried alongside the standard ChatCompletion / Chunk shape.
interface OAIMonadExt {
  session_id: string;
  agent_id?: string;
  cost_usd?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
}

type OAIChatCompletion = ChatCompletion & { x_monad?: OAIMonadExt };
type OAIChatChunk = ChatCompletionChunk & { x_monad?: OAIMonadExt };

// ── constants ─────────────────────────────────────────────────────────────────

const MAX_STREAMING_BACKLOG = 512;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_GC_INTERVAL_MS = 30 * 60 * 1000;
const MAX_USER_SESSIONS = 10_000;

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization, x-monad-agent-id, x-monad-session-id',
  'access-control-max-age': '86400'
};

// ── helpers ───────────────────────────────────────────────────────────────────

function oaiErrorResponse(message: string, status = 400, type = 'invalid_request_error', code?: string): Response {
  return new Response(JSON.stringify({ error: { message, type, ...(code ? { code } : {}) } }), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS }
  });
}

function disabled404(): Response {
  return oaiErrorResponse(
    'OpenAI-compat API is disabled. Set openaiCompat.enabled=true in profile.json.',
    404,
    'api_error',
    'disabled'
  );
}

function unauthorized401(): Response {
  return oaiErrorResponse('Invalid or missing Bearer token.', 401, 'api_error', 'unauthorized');
}

function handlerErrorToOai(err: unknown): Response {
  if (err instanceof HandlerError) {
    const { httpStatus } = HANDLER_ERROR_MAP[err.kind];
    return oaiErrorResponse(err.message, httpStatus, 'api_error', err.kind);
  }
  throw err;
}

function checkToken(request: Request, token: string): boolean {
  const header = request.headers.get('authorization') ?? '';
  const expected = `Bearer ${token}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  const len = Math.max(a.length, b.length, 1);
  const pa = Buffer.concat([a, Buffer.alloc(len - a.length)]);
  const pb = Buffer.concat([b, Buffer.alloc(len - b.length)]);
  return timingSafeEqual(pa, pb) && a.length === b.length;
}

// Wide content type covers the union of all ChatCompletionMessageParam.content variants.
type AnyContent = string | null | Array<{ type: string }> | undefined;

function extractText(content: AnyContent): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is ChatCompletionContentPartText => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

function buildUsage(
  usage:
    | {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
        reasoningTokens?: number;
      }
    | undefined
): CompletionUsage {
  return {
    prompt_tokens: usage?.inputTokens ?? 0,
    completion_tokens: usage?.outputTokens ?? 0,
    total_tokens: usage?.totalTokens ?? (usage ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) : 0),
    ...(usage?.cacheReadTokens !== undefined
      ? { prompt_tokens_details: { cached_tokens: usage.cacheReadTokens } }
      : {}),
    ...(usage?.reasoningTokens !== undefined
      ? { completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } }
      : {})
  };
}

function buildXMonad(
  sessionId: SessionId,
  agentId: AgentId | undefined,
  p: {
    cost?: { usd?: number };
    usage?: { cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number };
  }
): OAIMonadExt {
  return {
    session_id: sessionId,
    agent_id: agentId,
    cost_usd: p.cost?.usd,
    cache_read_tokens: p.usage?.cacheReadTokens,
    cache_write_tokens: p.usage?.cacheWriteTokens,
    reasoning_tokens: p.usage?.reasoningTokens
  };
}

function packContext(messages: ChatCompletionMessageParam[]): string {
  const system = messages.find((m) => m.role === 'system');
  const last = messages[messages.length - 1];
  const history = messages.slice(0, -1).filter((m) => m.role !== 'system');
  const parts: string[] = [];
  if (system) parts.push(`<system>\n${extractText(system.content)}\n</system>`);
  if (history.length > 0) {
    const lines = history.map(
      (m) => `${m.role === 'user' ? 'Human' : 'Assistant'}: ${extractText((m as { content?: AnyContent }).content)}`
    );
    parts.push(`<conversation_history>\n${lines.join('\n')}\n</conversation_history>`);
  }
  parts.push(extractText((last as { content?: AnyContent } | undefined)?.content));
  return parts.join('\n\n');
}

function buildAmbientContext(body: ChatCompletionCreateParamsBase): string | undefined {
  const hints: string[] = [];
  if (body.max_tokens) hints.push(`Limit your response to at most ${body.max_tokens} tokens.`);
  if (body.stop) {
    const stops = (Array.isArray(body.stop) ? body.stop : [body.stop]).filter(Boolean);
    if (stops.length > 0)
      hints.push(`Stop your response when you reach any of: ${stops.map((s) => JSON.stringify(s)).join(', ')}`);
  }
  if (body.response_format?.type === 'json_object') {
    hints.push('Respond with valid JSON only. Do not include any text outside the JSON object.');
  }
  if (body.temperature != null) {
    if (body.temperature < 0.3) hints.push('Be precise and deterministic. Avoid creative embellishments.');
    else if (body.temperature > 0.8) hints.push('Be creative and exploratory in your response.');
  }
  return hints.length > 0 ? hints.join('\n') : undefined;
}

function jsonResponse(body: unknown, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', ...CORS_HEADERS, ...(extra ?? {}) }
  });
}

const SESSION_ORIGIN = buildSessionOrigin({ transport: 'http', surface: 'api', client: 'openai-compat' });

// ── controller factory ────────────────────────────────────────────────────────

export type OpenAiCompatConfig = { enabled: boolean; token?: string };

// Route handlers return raw `Response` objects (OpenAI wire format), so Elysia can't infer
// a narrow response type — the resulting generic is incompatible with the base Elysia type
// that `.use()` expects.  The cast is safe: .use() only cares about runtime plugin setup.
export function createOpenAiCompatController(
  handlers: ReturnType<typeof createDaemonHandlers>,
  encoder: TextEncoder,
  getConfig: () => Promise<OpenAiCompatConfig>
  // biome-ignore lint/suspicious/noExplicitAny: Elysia's route generic conflicts with plugin signature; cast is safe at runtime
): Elysia<any, any, any, any, any, any, any> {
  type SessionEntry = { sessionId: SessionId; lastUsed: number };
  const userSessionData = new Map<string, SessionEntry>();
  const userSystemPrompts = new Map<string, string>();

  // GC: evict user-keyed sessions idle for more than SESSION_TTL_MS
  const gcTimer = setInterval(() => {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [key, entry] of userSessionData) {
      if (entry.lastUsed < cutoff) {
        userSessionData.delete(key);
        userSystemPrompts.delete(key);
      }
    }
  }, SESSION_GC_INTERVAL_MS);
  gcTimer.unref();

  async function guard(request: Request): Promise<Response | null> {
    const config = await getConfig();
    if (!config.enabled) return disabled404();
    // Fail closed: this API drives the agent with tools, and the daemon's loopback bind makes it
    // reachable by any local process / co-tenant. Refuse to serve without a configured token rather
    // than silently exposing an unauthenticated agent-driving endpoint.
    if (!config.token) {
      return oaiErrorResponse(
        'OpenAI-compat API requires a token. Set openaiCompat.token in profile.json.',
        401,
        'api_error',
        'unauthorized'
      );
    }
    if (!checkToken(request, config.token)) return unauthorized401();
    return null;
  }

  return (
    new Elysia({ tags: ['http-only'] })
      // ── CORS preflight ────────────────────────────────────────────────────────
      .options('/', () => new Response(null, { status: 204, headers: CORS_HEADERS }))
      .options('/v1/*', () => new Response(null, { status: 204, headers: CORS_HEADERS }))
      // ── service info ──────────────────────────────────────────────────────────
      .get('/', async ({ request }) => {
        const block = await guard(request);
        if (block) return block;
        return jsonResponse({
          name: 'Monad OpenAI-compatible API',
          version: '1',
          paths: ['/v1/models', '/v1/chat/completions', '/v1/embeddings']
        });
      })
      // ── models list ───────────────────────────────────────────────────────────
      .get('/v1/models', async ({ request }) => {
        const block = await guard(request);
        if (block) return block;
        try {
          const { agents } = await handlers.agent.listAgents();
          // Only public agents are exposed — no fall-back-to-all (would disclose private agents'
          // names/descriptions). Matches the completion path's addressability gate.
          const listed = agents.filter((a) => a.visibility?.public);
          const ts = Math.floor(Date.now() / 1000);
          return jsonResponse({
            object: 'list',
            data: listed.map((a) => ({
              id: a.id,
              object: 'model',
              created: ts,
              owned_by: 'monad',
              name: a.name,
              description: a.description
            }))
          });
        } catch (err) {
          return handlerErrorToOai(err);
        }
      })
      // ── model by id ───────────────────────────────────────────────────────────
      .get('/v1/models/:id', async ({ request, params }) => {
        const block = await guard(request);
        if (block) return block;
        try {
          const { agents } = await handlers.agent.listAgents();
          // Only public agents are addressable — don't disclose a private agent's metadata by id/name.
          const agent = agents.find((a) => a.visibility?.public && (a.id === params.id || a.name === params.id));
          if (!agent)
            return oaiErrorResponse(`Model not found: ${params.id}`, 404, 'invalid_request_error', 'model_not_found');
          return jsonResponse({
            id: agent.id,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: 'monad',
            name: agent.name,
            description: agent.description
          });
        } catch (err) {
          return handlerErrorToOai(err);
        }
      })
      // ── embeddings ────────────────────────────────────────────────────────────
      .post('/v1/embeddings', async ({ request }) => {
        const block = await guard(request);
        if (block) return block;

        let body: EmbeddingCreateParams;
        try {
          body = (await request.json()) as EmbeddingCreateParams;
        } catch {
          return oaiErrorResponse('Invalid JSON in request body');
        }
        if (!body.input) return oaiErrorResponse('input is required');

        const texts: string[] =
          typeof body.input === 'string'
            ? [body.input]
            : (body.input as unknown[]).filter((x): x is string => typeof x === 'string');
        if (texts.length === 0) return oaiErrorResponse('input must be a non-empty string or array');

        try {
          const result = await handlers.embeddings.embed(texts);
          return jsonResponse({
            object: 'list',
            data: result.embeddings.map((embedding, index) => ({ object: 'embedding', index, embedding })),
            model: body.model,
            usage: {
              prompt_tokens: result.usage?.inputTokens ?? 0,
              total_tokens: result.usage?.totalTokens ?? result.usage?.inputTokens ?? 0
            }
          });
        } catch (err) {
          return handlerErrorToOai(err);
        }
      })
      // ── chat completions ──────────────────────────────────────────────────────
      .post('/v1/chat/completions', async ({ request }) => {
        const block = await guard(request);
        if (block) return block;

        let body: ChatCompletionCreateParamsBase;
        try {
          body = (await request.json()) as ChatCompletionCreateParamsBase;
        } catch {
          return oaiErrorResponse('Invalid JSON in request body');
        }

        if (!body.model || typeof body.model !== 'string') return oaiErrorResponse('model is required');
        if (!Array.isArray(body.messages) || body.messages.length === 0)
          return oaiErrorResponse('messages must be a non-empty array');
        const lastMsg = body.messages[body.messages.length - 1];
        if (lastMsg?.role !== 'user') return oaiErrorResponse('last message must have role "user"');
        if (body.n !== undefined && body.n !== 1) {
          return oaiErrorResponse(
            `n=${body.n} is not supported — Monad returns one completion per request. Set n=1 or omit it.`,
            400,
            'invalid_request_error',
            'unsupported_parameter'
          );
        }

        // Resolve agent: header override > model id/name > default. Only `visibility.public` agents
        // are addressable by id/name — a private/privileged agent must never be reachable here, even
        // when zero agents are public (in which case only the implicit `default` agent runs). No
        // fall-back-to-all: `public` defaults false, so a fallback would expose every agent.
        const agentOverride = request.headers.get('x-monad-agent-id');
        let agents: Awaited<ReturnType<typeof handlers.agent.listAgents>>['agents'];
        try {
          ({ agents } = await handlers.agent.listAgents());
        } catch (err) {
          return handlerErrorToOai(err);
        }
        const selectable = agents.filter((a) => a.visibility?.public);
        const requestedAgent = agentOverride ?? (body.model !== 'default' ? body.model : undefined);
        let agentId: AgentId | undefined;
        if (requestedAgent) {
          const match = selectable.find((a) => a.id === requestedAgent || a.name === requestedAgent);
          if (!match) {
            return oaiErrorResponse(
              `Model not found: ${requestedAgent}`,
              404,
              'invalid_request_error',
              'model_not_found'
            );
          }
          agentId = match.id;
        }

        // Resolve or create session
        const sessionIdOverride = request.headers.get('x-monad-session-id') as SessionId | null;
        let sessionId: SessionId;
        let isNewSession: boolean;
        const userKey = body.user ? `openai-compat:${body.user}` : null;
        const currentSystem = body.messages.find((m) => m.role === 'system');
        const currentSystemText = currentSystem !== undefined ? extractText(currentSystem.content) : undefined;

        const existingEntry = userKey ? userSessionData.get(userKey) : undefined;

        if (sessionIdOverride) {
          // A caller-supplied session id must reference a session this API itself created — never an
          // interactive (web/tui/editor/channel) session of the owner. `writableBy` alone can't tell
          // those apart (web/tui/api all collapse to the `http` transport), so gate on origin.client.
          // Return one uniform 403 whether the session is missing OR non-delegation, so the status
          // code can't be used to enumerate which session ids exist.
          let overrideSession: Awaited<ReturnType<typeof handlers.session.get>>['session'] | undefined;
          try {
            ({ session: overrideSession } = await handlers.session.get({ id: sessionIdOverride }));
          } catch {
            overrideSession = undefined;
          }
          if (!overrideSession || !isInboundDelegationSession(overrideSession.origin)) {
            return oaiErrorResponse(
              'x-monad-session-id must reference a session created via the OpenAI-compat API.',
              403,
              'api_error',
              'forbidden'
            );
          }
          sessionId = sessionIdOverride;
          isNewSession = false;
        } else if (existingEntry) {
          sessionId = existingEntry.sessionId;
          existingEntry.lastUsed = Date.now();
          isNewSession = false;
        } else {
          try {
            const result = await handlers.session.create({ title: 'openai-compat', agentId, origin: SESSION_ORIGIN });
            sessionId = result.sessionId;
          } catch (err) {
            return handlerErrorToOai(err);
          }
          isNewSession = true;
          if (userKey && userSessionData.size < MAX_USER_SESSIONS) {
            userSessionData.set(userKey, { sessionId, lastUsed: Date.now() });
            if (currentSystemText !== undefined) userSystemPrompts.set(userKey, currentSystemText);
          }
        }

        // Build text: new session → full context pack; existing → last user message,
        // prepending updated system instructions if they changed.
        let text: string;
        if (isNewSession) {
          text = packContext(body.messages);
        } else {
          const prevSystem = userKey ? (userSystemPrompts.get(userKey) ?? '') : '';
          const systemChanged = currentSystemText !== undefined && currentSystemText !== prevSystem;
          if (systemChanged && currentSystemText !== undefined) {
            if (userKey && userSessionData.has(userKey)) userSystemPrompts.set(userKey, currentSystemText);
            text = `[Updated system instructions]\n${currentSystemText}\n\n${extractText((lastMsg as { content?: AnyContent }).content)}`;
          } else {
            text = extractText((lastMsg as { content?: AnyContent }).content);
          }
        }

        const ambientContext = buildAmbientContext(body);
        const completionId = newId('chatcmpl').replace('_', '-');
        const createdAt = Math.floor(Date.now() / 1000);
        const modelLabel = agentId ?? body.model;

        if (body.stream) {
          const stream = new ReadableStream<Uint8Array>({
            async start(ctrl) {
              let dropped = false;
              try {
                await handlers.session.sendInline(
                  { sessionId, text },
                  (event) => {
                    if (dropped || ctrl.desiredSize === null) return;
                    if (event.type === 'agent.token') {
                      const p = parseEventPayload('agent.token', event.payload as Record<string, unknown>);
                      const chunk: OAIChatChunk = {
                        id: completionId,
                        object: 'chat.completion.chunk',
                        created: createdAt,
                        model: modelLabel,
                        choices: [{ index: 0, delta: { role: 'assistant', content: p.delta }, finish_reason: null }]
                      };
                      ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                    } else if (event.type === 'agent.message') {
                      const p = parseEventPayload('agent.message', event.payload as Record<string, unknown>);
                      const finalChunk: OAIChatChunk = {
                        id: completionId,
                        object: 'chat.completion.chunk',
                        created: createdAt,
                        model: modelLabel,
                        choices: [
                          {
                            index: 0,
                            delta: {},
                            finish_reason: (p.finishReason ?? 'stop') as ChatCompletionChunk.Choice['finish_reason']
                          }
                        ],
                        usage: buildUsage(p.usage),
                        x_monad: buildXMonad(sessionId, agentId, p)
                      };
                      ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\ndata: [DONE]\n\n`));
                    }
                    if (!dropped && (ctrl.desiredSize ?? 0) < -MAX_STREAMING_BACKLOG) {
                      dropped = true;
                      void handlers.session.abort({ id: sessionId });
                      try {
                        ctrl.close();
                      } catch {}
                    }
                  },
                  { transport: 'http', ambientContext }
                );
              } catch (err) {
                try {
                  const msg = err instanceof HandlerError ? err.message : 'An internal error occurred.';
                  const errChunk = JSON.stringify({ error: { message: msg, type: 'api_error', code: 'stream_error' } });
                  ctrl.enqueue(encoder.encode(`data: ${errChunk}\n\ndata: [DONE]\n\n`));
                } catch {}
              } finally {
                if (!dropped) {
                  try {
                    ctrl.close();
                  } catch {}
                }
              }
            },
            cancel() {
              void handlers.session.abort({ id: sessionId });
            }
          });
          return new Response(stream, { headers: { ...SSE_RESPONSE_HEADERS, ...CORS_HEADERS } });
        }

        // Non-streaming: collect agent.message and return JSON
        let resultText = '';
        let resultUsage: CompletionUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
        let resultXMonad: OAIMonadExt = { session_id: sessionId, agent_id: agentId };
        let finishReason: ChatCompletion.Choice['finish_reason'] = 'stop';

        try {
          await handlers.session.sendInline(
            { sessionId, text },
            (event) => {
              if (event.type === 'agent.message') {
                const p = parseEventPayload('agent.message', event.payload as Record<string, unknown>);
                resultText = p.text;
                resultUsage = buildUsage(p.usage);
                resultXMonad = buildXMonad(sessionId, agentId, p);
                finishReason = (p.finishReason ?? 'stop') as ChatCompletion.Choice['finish_reason'];
              }
            },
            { transport: 'http', ambientContext }
          );
        } catch (err) {
          return handlerErrorToOai(err);
        }

        const completion: OAIChatCompletion = {
          id: completionId,
          object: 'chat.completion',
          created: createdAt,
          model: modelLabel,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: resultText, refusal: null },
              finish_reason: finishReason,
              logprobs: null
            }
          ],
          usage: resultUsage,
          x_monad: resultXMonad
        };

        return jsonResponse(completion, {
          'x-ratelimit-limit-requests': '1000',
          'x-ratelimit-remaining-requests': '999',
          'x-ratelimit-reset-requests': '1s'
        });
      })
  );
}
