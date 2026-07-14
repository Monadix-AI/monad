// e2e: OpenAI Responses API proxy (/openai/v1/responses) over both TCP and Unix.
// Tests the non-streaming and streaming paths, session continuity via
// previous_response_id, auth gating, agent resolution, and CRUD lifecycle.

import { describe, expect, test } from 'bun:test';

import { MOCK_REPLY } from '#/infra/mock-model.ts';
import { createHttpTransport } from '#/transports/http.ts';
import { buildHandlers, mockModel, serveTransport, TRANSPORTS } from '../helpers.ts';

// ── SSE helpers ──────────────────────────────────────────────────────────────

interface RespEvent {
  type: string;
  [key: string]: unknown;
}

async function _readResponsesSSE(
  url: string,
  opts: { headers?: Record<string, string>; unix?: string; timeoutMs?: number }
): Promise<RespEvent[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000);
  const events: RespEvent[] = [];
  try {
    const res = await fetch(url, { method: 'POST', headers: opts.headers, signal: controller.signal, unix: opts.unix });
    const reader = res.body?.getReader();
    if (!reader) return events;
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let sep = buf.indexOf('\n\n');
      while (sep !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
        if (dataLine) {
          const e = JSON.parse(dataLine.slice(6)) as RespEvent;
          events.push(e);
          if (e.type === 'response.completed' || e.type === 'error') {
            controller.abort();
            return events;
          }
        }
        sep = buf.indexOf('\n\n');
      }
    }
  } catch {
    // aborted (timeout or completed) — fall through
  } finally {
    clearTimeout(timer);
  }
  return events;
}

// ── factory ───────────────────────────────────────────────────────────────────

const TEST_TOKEN = 'test-token';
const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };

function makeApp(token: string = TEST_TOKEN) {
  const handlers = buildHandlers(mockModel());
  return createHttpTransport(handlers, {
    openaiCompatConfig: () => Promise.resolve({ enabled: true, token })
  });
}

function disabledApp() {
  return createHttpTransport(buildHandlers(mockModel()), {
    openaiCompatConfig: () => Promise.resolve({ enabled: false })
  });
}

// ── auth guard ────────────────────────────────────────────────────────────────

describe('auth guard', () => {
  test('disabled → 404 with error code', async () => {
    const t = serveTransport('tcp', disabledApp());
    try {
      const res = await t.fetch('/openai/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...AUTH },
        body: JSON.stringify({ model: 'default', input: 'hi' })
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('disabled');
    } finally {
      await t.stop();
    }
  });

  test('wrong token → 401', async () => {
    const t = serveTransport('tcp', makeApp('correct-token'));
    try {
      const res = await t.fetch('/openai/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
        body: JSON.stringify({ model: 'default', input: 'hi' })
      });
      expect(res.status).toBe(401);
    } finally {
      await t.stop();
    }
  });

  test('correct token → 200', async () => {
    const t = serveTransport('tcp', makeApp('mytoken'));
    try {
      const res = await t.fetch('/openai/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer mytoken' },
        body: JSON.stringify({ model: 'default', input: 'hi' })
      });
      expect(res.status).toBe(200);
    } finally {
      await t.stop();
    }
  });
});

// ── validation errors ─────────────────────────────────────────────────────────

describe('validation errors', () => {
  test('missing model → 400', async () => {
    const t = serveTransport('tcp', makeApp());
    try {
      const res = await t.fetch('/openai/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...AUTH },
        body: JSON.stringify({ input: 'hi' })
      });
      expect(res.status).toBe(400);
    } finally {
      await t.stop();
    }
  });

  test('missing input → 400', async () => {
    const t = serveTransport('tcp', makeApp());
    try {
      const res = await t.fetch('/openai/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...AUTH },
        body: JSON.stringify({ model: 'default' })
      });
      expect(res.status).toBe(400);
    } finally {
      await t.stop();
    }
  });

  test('unknown previous_response_id → 404', async () => {
    const t = serveTransport('tcp', makeApp());
    try {
      const res = await t.fetch('/openai/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...AUTH },
        body: JSON.stringify({ model: 'default', input: 'hi', previous_response_id: 'resp-does-not-exist' })
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('response_not_found');
    } finally {
      await t.stop();
    }
  });
});

// ── non-streaming ─────────────────────────────────────────────────────────────

for (const kind of TRANSPORTS) {
  describe(`non-streaming over ${kind}`, () => {
    test('string input → completed ResponseObject', async () => {
      const t = serveTransport(kind, makeApp());
      try {
        const res = await t.fetch('/openai/v1/responses', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...AUTH },
          body: JSON.stringify({ model: 'default', input: 'hello' })
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          id: string;
          object: string;
          status: string;
          output: { type: string; role: string; content: { type: string; text: string }[] }[];
          usage: { input_tokens: number; output_tokens: number; total_tokens: number };
          x_monad: { session_id: string };
        };
        expect(body.object).toBe('response');
        expect(body.status).toBe('completed');
        expect(body.id).toMatch(/^resp-/);
        expect(body.output).toHaveLength(1);
        expect(body.output.at(0)?.type).toBe('message');
        expect(body.output.at(0)?.role).toBe('assistant');
        expect(body.output.at(0)?.content.at(0)?.type).toBe('output_text');
        expect(body.output.at(0)?.content.at(0)?.text).toBe(MOCK_REPLY);
        expect(body.usage.output_tokens).toBeGreaterThanOrEqual(0);
        expect(body.x_monad.session_id).toMatch(/^ses_/);
      } finally {
        await t.stop();
      }
    });

    test('array-of-messages input', async () => {
      const t = serveTransport(kind, makeApp());
      try {
        const res = await t.fetch('/openai/v1/responses', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...AUTH },
          body: JSON.stringify({
            model: 'default',
            input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }]
          })
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; output: { content: { text: string }[] }[] };
        expect(body.status).toBe('completed');
        expect(body.output.at(0)?.content.at(0)?.text).toBe(MOCK_REPLY);
      } finally {
        await t.stop();
      }
    });

    test('instructions are accepted without error', async () => {
      const t = serveTransport(kind, makeApp());
      try {
        const res = await t.fetch('/openai/v1/responses', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...AUTH },
          body: JSON.stringify({ model: 'default', input: 'hi', instructions: 'You are a pirate.' })
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { instructions: string };
        expect(body.instructions).toBe('You are a pirate.');
      } finally {
        await t.stop();
      }
    });

    test('previous_response_id → same session reused', async () => {
      const t = serveTransport(kind, makeApp());
      try {
        const first = (await t
          .fetch('/openai/v1/responses', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...AUTH },
            body: JSON.stringify({ model: 'default', input: 'turn 1' })
          })
          .then((r) => r.json())) as { id: string; x_monad: { session_id: string } };

        const second = (await t
          .fetch('/openai/v1/responses', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...AUTH },
            body: JSON.stringify({ model: 'default', input: 'turn 2', previous_response_id: first.id })
          })
          .then((r) => r.json())) as { previous_response_id: string; x_monad: { session_id: string } };

        expect(second.previous_response_id).toBe(first.id);
        expect(second.x_monad.session_id).toBe(first.x_monad.session_id);
      } finally {
        await t.stop();
      }
    });

    test('store=false → response not retrievable', async () => {
      const t = serveTransport(kind, makeApp());
      try {
        const create = (await t
          .fetch('/openai/v1/responses', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...AUTH },
            body: JSON.stringify({ model: 'default', input: 'hi', store: false })
          })
          .then((r) => r.json())) as { id: string };

        const get = await t.fetch(`/openai/v1/responses/${create.id}`, { headers: AUTH });
        expect(get.status).toBe(404);
      } finally {
        await t.stop();
      }
    });
  });
}

// ── retrieve & delete ─────────────────────────────────────────────────────────

for (const kind of TRANSPORTS) {
  describe(`GET/DELETE /openai/v1/responses/:id over ${kind}`, () => {
    test('retrieve a stored response', async () => {
      const t = serveTransport(kind, makeApp());
      try {
        const create = (await t
          .fetch('/openai/v1/responses', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...AUTH },
            body: JSON.stringify({ model: 'default', input: 'fetch me' })
          })
          .then((r) => r.json())) as { id: string };

        const get = await t.fetch(`/openai/v1/responses/${create.id}`, { headers: AUTH });
        expect(get.status).toBe(200);
        const body = (await get.json()) as { id: string; status: string };
        expect(body.id).toBe(create.id);
        expect(body.status).toBe('completed');
      } finally {
        await t.stop();
      }
    });

    test('retrieve unknown id → 404', async () => {
      const t = serveTransport(kind, makeApp());
      try {
        const res = await t.fetch('/openai/v1/responses/resp-unknown', { headers: AUTH });
        expect(res.status).toBe(404);
      } finally {
        await t.stop();
      }
    });

    test('delete a response and confirm gone', async () => {
      const t = serveTransport(kind, makeApp());
      try {
        const create = (await t
          .fetch('/openai/v1/responses', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...AUTH },
            body: JSON.stringify({ model: 'default', input: 'delete me' })
          })
          .then((r) => r.json())) as { id: string };

        const del = await t.fetch(`/openai/v1/responses/${create.id}`, { method: 'DELETE', headers: AUTH });
        expect(del.status).toBe(200);
        const body = (await del.json()) as { deleted: boolean };
        expect(body.deleted).toBe(true);

        const after = await t.fetch(`/openai/v1/responses/${create.id}`, { headers: AUTH });
        expect(after.status).toBe(404);
      } finally {
        await t.stop();
      }
    });

    test('delete unknown id → 404', async () => {
      const t = serveTransport(kind, makeApp());
      try {
        const res = await t.fetch('/openai/v1/responses/resp-unknown', { method: 'DELETE', headers: AUTH });
        expect(res.status).toBe(404);
      } finally {
        await t.stop();
      }
    });
  });
}

// ── streaming ─────────────────────────────────────────────────────────────────

for (const kind of TRANSPORTS) {
  describe(`streaming SSE over ${kind}`, () => {
    test('emits correct event sequence and completes', async () => {
      const t = serveTransport(kind, makeApp());
      try {
        // Build a streaming request manually since the t.sse helper reads monad protocol events
        const reqInit: RequestInit & { unix?: string } = {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...AUTH },
          body: JSON.stringify({ model: 'default', input: 'stream me', stream: true })
        };
        const _url = kind === 'unix' ? (t as unknown as { _sock: string })._sock : undefined;

        // Use the custom SSE reader
        const _baseUrl = await (async () => {
          // Grab base URL via a non-streaming call to the same server
          const probe = await t.fetch('/openai/v1/responses', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...AUTH },
            body: JSON.stringify({ model: 'default', input: 'probe' })
          });
          await probe.json(); // drain
          return '';
        })();

        // For streaming we need to drive fetch directly through the handle
        const streamRes = await t.fetch('/openai/v1/responses', {
          ...reqInit,
          headers: { 'content-type': 'application/json', ...AUTH }
        });
        expect(streamRes.headers.get('content-type')).toContain('text/event-stream');

        const dec = new TextDecoder();
        let buf = '';
        const events: RespEvent[] = [];
        if (!streamRes.body) throw new Error('streaming response has no body');
        const reader = streamRes.body.getReader();
        const timeout = setTimeout(() => reader.cancel(), 5000);
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let sep = buf.indexOf('\n\n');
            while (sep !== -1) {
              const frame = buf.slice(0, sep);
              buf = buf.slice(sep + 2);
              const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
              if (dataLine) events.push(JSON.parse(dataLine.slice(6)) as RespEvent);
              sep = buf.indexOf('\n\n');
            }
            if (events.at(-1)?.type === 'response.completed') break;
          }
        } finally {
          clearTimeout(timeout);
        }

        const types = events.map((e) => e.type);
        expect(types[0]).toBe('response.created');
        expect(types).toContain('response.output_item.added');
        expect(types).toContain('response.content_part.added');
        expect(types).toContain('response.output_text.delta');
        expect(types).toContain('response.output_text.done');
        expect(types).toContain('response.content_part.done');
        expect(types).toContain('response.output_item.done');
        expect(types.at(-1)).toBe('response.completed');

        // accumulated text == MOCK_REPLY
        const deltas = events.filter((e) => e.type === 'response.output_text.delta').map((e) => e.delta as string);
        expect(deltas.join('')).toBe(MOCK_REPLY);

        // done event carries the full text
        const doneEvt = events.find((e) => e.type === 'response.output_text.done') as { text?: string } | undefined;
        expect(doneEvt?.text).toBe(MOCK_REPLY);

        // completed response is stored
        const completed = events.find((e) => e.type === 'response.completed') as
          | { response?: { id: string; status: string } }
          | undefined;
        expect(completed?.response?.status).toBe('completed');

        const respId = completed?.response?.id;
        expect(respId).toMatch(/^resp-/);
        const getRes = await t.fetch(`/openai/v1/responses/${respId}`, { headers: AUTH });
        expect(getRes.status).toBe(200);
      } finally {
        await t.stop();
      }
    });

    test('streaming response with stream=true has in_progress status initially', async () => {
      const t = serveTransport(kind, makeApp());
      try {
        const res = await t.fetch('/openai/v1/responses', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...AUTH },
          body: JSON.stringify({ model: 'default', input: 'hi', stream: true })
        });
        expect(res.status).toBe(200);

        const dec = new TextDecoder();
        let buf = '';
        let firstEvent: RespEvent | null = null;
        if (!res.body) throw new Error('streaming response has no body');
        const reader = res.body.getReader();
        const timeout = setTimeout(() => reader.cancel(), 5000);
        try {
          outer: for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let sep = buf.indexOf('\n\n');
            while (sep !== -1) {
              const frame = buf.slice(0, sep);
              buf = buf.slice(sep + 2);
              const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
              if (dataLine) {
                firstEvent = JSON.parse(dataLine.slice(6)) as RespEvent;
                break outer;
              }
              sep = buf.indexOf('\n\n');
            }
          }
        } finally {
          clearTimeout(timeout);
          await reader.cancel();
        }

        expect(firstEvent?.type).toBe('response.created');
        const resp = firstEvent?.response as { status?: string } | undefined;
        expect(resp?.status).toBe('in_progress');
      } finally {
        await t.stop();
      }
    });
  });
}

// ── CORS preflight ────────────────────────────────────────────────────────────

describe('CORS preflight', () => {
  test('OPTIONS /openai/v1/responses with loopback origin reflects custom headers', async () => {
    const t = serveTransport('tcp', makeApp());
    try {
      const res = await t.fetch('/openai/v1/responses', {
        method: 'OPTIONS',
        headers: {
          origin: 'http://localhost',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'x-monad-agent-id, x-monad-session-id'
        }
      });
      expect(res.status).toBe(204);
      const allowed = res.headers.get('access-control-allow-headers') ?? '';
      expect(allowed).toContain('x-monad-agent-id');
      expect(allowed).toContain('x-monad-session-id');
    } finally {
      await t.stop();
    }
  });
});

// ── streaming error sanitization ──────────────────────────────────────────────

describe('streaming error sanitization', () => {
  test('non-HandlerError during streaming emits generic message over SSE', async () => {
    const base = buildHandlers(mockModel());
    // Override sendInline to throw a raw Error — simulates an unexpected internal failure
    // (e.g. a DB invariant violation) that must never leak its message to the client.
    const handlers = {
      ...base,
      session: {
        ...base.session,
        sendInline: async (): Promise<void> => {
          throw new Error('raw internal: UNIQUE constraint failed on sessions.id');
        }
      }
    } as ReturnType<typeof buildHandlers>;
    const app = createHttpTransport(handlers, {
      openaiCompatConfig: () => Promise.resolve({ enabled: true, token: TEST_TOKEN })
    });
    const t = serveTransport('tcp', app);
    try {
      const res = await t.fetch('/openai/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...AUTH },
        body: JSON.stringify({ model: 'default', input: 'trigger error', stream: true })
      });
      expect(res.status).toBe(200);

      const dec = new TextDecoder();
      let buf = '';
      let errorData: { type: string; error: { message: string } } | null = null;
      if (!res.body) throw new Error('expected streaming response body');
      const reader = res.body.getReader();
      const timeout = setTimeout(() => reader.cancel(), 5000);
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let sep = buf.indexOf('\n\n');
          while (sep !== -1) {
            const frame = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            const lines = frame.split('\n');
            const isErrorEvent = lines.some((l) => l === 'event: error');
            const dataLine = lines.find((l) => l.startsWith('data: '));
            if (isErrorEvent && dataLine) {
              errorData = JSON.parse(dataLine.slice(6)) as { type: string; error: { message: string } };
              break;
            }
            sep = buf.indexOf('\n\n');
          }
          if (errorData) break;
        }
      } finally {
        clearTimeout(timeout);
        await reader.cancel().catch(() => {});
      }

      if (errorData === null) throw new Error('expected errorData to be set');
      expect(errorData.error.message).toBe('An internal error occurred.');
      expect(errorData.error.message).not.toContain('UNIQUE constraint');
    } finally {
      await t.stop();
    }
  });
});

// ── x-monad-session-id override ───────────────────────────────────────────────

describe('x-monad-session-id header override', () => {
  test('two requests sharing a session-id header reuse the same session', async () => {
    const t = serveTransport('tcp', makeApp());
    try {
      // First: create a session
      const first = (await t
        .fetch('/openai/v1/responses', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...AUTH },
          body: JSON.stringify({ model: 'default', input: 'turn 1' })
        })
        .then((r) => r.json())) as { x_monad: { session_id: string } };

      const sessionId = first.x_monad.session_id;

      // Second: explicitly pin to that session
      const second = (await t
        .fetch('/openai/v1/responses', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...AUTH, 'x-monad-session-id': sessionId },
          body: JSON.stringify({ model: 'default', input: 'turn 2' })
        })
        .then((r) => r.json())) as { x_monad: { session_id: string } };

      expect(second.x_monad.session_id).toBe(sessionId);
    } finally {
      await t.stop();
    }
  });
});
