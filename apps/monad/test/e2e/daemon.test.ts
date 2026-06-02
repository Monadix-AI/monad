import type { ChatMessage, Event, MeshAgentStateFrame, MessageId, SessionId, SessionUiEvent } from '@monad/protocol';
import type { MessageRepo, ModelRouter } from '#/agent/index.ts';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eventSchema, httpErrorSchema, messageIdSchema, newId, parseEventPayload } from '@monad/protocol';

import { replayHistory } from '#/agent/loop/replay.ts';
import { createMessageRetrieveTool } from '#/capabilities/tools/registry/message-retrieve.ts';
import { EventBus } from '#/services/event-bus.ts';
import { encodeEventCursor } from '#/services/event-cursor.ts';
import { createMessageIngress, messageIdempotencyKey } from '#/services/messages/ingress.ts';
import { MessageLookup } from '#/services/messages/lookup.ts';
import { createStore } from '#/store/db/index.ts';
import { createHttpTransport } from '#/transports/http.ts';
import { buildHandlers, mockModel, serveTransport, TRANSPORTS, type TransportHandle } from '../helpers.ts';
import { connectionGate, waitFor } from '../wait.ts';

function createGate() {
  let markStarted!: () => void;
  let release!: () => void;
  return {
    started: new Promise<void>((resolve) => {
      markStarted = resolve;
    }),
    released: new Promise<void>((resolve) => {
      release = resolve;
    }),
    markStarted,
    release
  };
}

function canonicalHttpError(raw: unknown) {
  const body = httpErrorSchema.parse(raw);
  expect(body.requestId).toMatch(/^req_[0-9a-zA-Z]{12}$/);
  return { ...body, requestId: '<requestId>' };
}

const replyTargetNotFoundError = {
  error: 'reply_target_not_found',
  code: 'NOT_FOUND',
  retryable: false,
  requestId: '<requestId>'
};

const requestValidationError = {
  error: 'request validation failed',
  code: 'VALIDATION',
  retryable: false,
  requestId: '<requestId>',
  details: { issues: ['request validation failed'] }
};

// E2E: the full HTTP + SSE stack against a deterministic mock model (no network), covering both
// generation interfaces and resume. Runs identically over TCP loopback AND the unix socket.

for (const kind of TRANSPORTS) {
  describe(`daemon over ${kind}`, () => {
    let t: TransportHandle;

    beforeAll(() => {
      // 30ms/token spacing keeps a streaming round in flight long enough to test resume.
      t = serveTransport(kind, createHttpTransport(buildHandlers(mockModel(['Hel', 'lo', ' ', 'wor', 'ld'], 30))));
    });

    afterAll(() => t.stop());

    async function createSession(title: string): Promise<SessionId> {
      const res = await t.fetch('/v1/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title })
      });
      return ((await res.json()) as { sessionId: SessionId }).sessionId;
    }

    function send(sessionId: string, text: string): Promise<Response> {
      return t.fetch(`/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text })
      });
    }

    test('GET /health via real HTTP', async () => {
      const res = await t.fetch('/health');
      expect(res.status).toBe(200);
      expect(((await res.json()) as { status: string }).status).toBe('ok');
    });

    test('session list searches within the requested archived scope', async () => {
      const activeSessionId = await createSession('Runtime gateway');
      const archivedSessionId = await createSession('Runtime archive');
      await t.fetch(`/v1/sessions/${archivedSessionId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ archived: true })
      });

      const active = (await (await t.fetch('/v1/sessions?archived=false&query=gateway&limit=20&offset=0')).json()) as {
        sessions: { id: string }[];
        total: number;
      };
      const archived = (await (await t.fetch('/v1/sessions?archived=true&query=archive&limit=20&offset=0')).json()) as {
        sessions: { id: string }[];
        total: number;
      };

      expect(active).toMatchObject({ sessions: [{ id: activeSessionId }], total: 1 });
      expect(archived).toMatchObject({ sessions: [{ id: archivedSessionId }], total: 1 });
    });

    test('GET /health includes upgrade info when the daemon monitor has a result', async () => {
      const withUpgrade = serveTransport(
        kind,
        createHttpTransport(
          buildHandlers(mockModel([]), undefined, {
            getUpgradeInfo: () => ({
              latestVersion: '9.9.9',
              latestVersionCheckedAt: '2026-07-01T00:00:00.000Z'
            })
          })
        )
      );
      try {
        const res = await withUpgrade.fetch('/health');
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({
          status: 'ok',
          latestVersion: '9.9.9',
          latestVersionCheckedAt: '2026-07-01T00:00:00.000Z'
        });
      } finally {
        await withUpgrade.stop();
      }
    });

    test('loopback browser requests receive CORS headers on validation errors', async () => {
      const sessionId = await createSession('cors-validation');
      const res = await t.fetch(`/v1/sessions/${sessionId}/messages?limit=abc`, {
        headers: { origin: 'http://localhost:3000' }
      });

      expect(res.status).toBe(400);
      expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
      expect(res.headers.get('access-control-allow-credentials')).toBe('true');
      expect(((await res.json()) as { code?: string }).code).toBe('VALIDATION');
    });

    test('GET /sessions/:id/ui-items accepts browser query strings', async () => {
      const sessionId = await createSession('ui-items-query');
      const res = await t.fetch(`/v1/sessions/${sessionId}/ui-items?limit=50&includeInactive=false`, {
        headers: { origin: 'http://localhost:3000' }
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
      expect((await res.json()) as { items: unknown[] }).toEqual({ items: [] });
    });

    test('streaming: SSE delivers ordered message deltas then a completed message', async () => {
      const sessionId = await createSession('stream');

      // Subscribe first, then send, so we observe the whole round.
      const gate = connectionGate();
      const eventsP = t.sse(`/v1/sessions/${sessionId}/events`, {
        until: (e) => e.type === 'session.message.completed',
        timeoutMs: 3000,
        onConnected: gate.onConnected
      });
      await gate.ready;
      await send(sessionId, 'hi');

      const events = await eventsP;
      const tokens = events.filter((e) => e.type === 'session.message.delta.appended');
      const finals = events.filter((e) => e.type === 'session.message.completed');

      expect(tokens.length).toBeGreaterThan(0);
      // token deltas concatenate to the full reply, in order
      const text = tokens.map((e) => parseEventPayload('session.message.delta.appended', e.payload).delta).join('');
      expect(text).toBe('Hello world');
      expect(tokens.map((e) => parseEventPayload('session.message.delta.appended', e.payload).index)).toEqual(
        tokens.map((_e, i) => i)
      );
      expect(finals).toHaveLength(1);
      const final = finals[0];
      if (!final) throw new Error('missing completed message');
      expect(parseEventPayload('session.message.completed', final.payload).message.text).toBe('Hello world');
    });

    test('block: POST .../messages/block returns the full assistant message synchronously', async () => {
      const sessionId = await createSession('block');
      const res = await t.fetch(`/v1/sessions/${sessionId}/messages/block`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hi' })
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { message: { role: string; text: string } };
      expect(body.message.role).toBe('assistant');
      expect(body.message.text).toBe('Hello world');
    });

    test('user replies round-trip through the canonical event and history while the answer links to its trigger', async () => {
      const sessionId = await createSession('reply-round-trip');
      const first = await t.fetch(`/v1/sessions/${sessionId}/messages/block`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'original question' })
      });
      expect(first.status).toBe(200);

      const initialHistory = (await (await t.fetch(`/v1/sessions/${sessionId}/messages`)).json()) as {
        messages: ChatMessage[];
      };
      const target = initialHistory.messages[1];
      if (!target) throw new Error('initial assistant target was not persisted');

      const gate = connectionGate();
      const createdReply = t.sse(`/v1/sessions/${sessionId}/events`, {
        until: (event) =>
          event.type === 'session.message.created' &&
          parseEventPayload('session.message.created', event.payload).message.text === 'follow-up reply',
        timeoutMs: 3000,
        onConnected: gate.onConnected
      });
      await gate.ready;
      const sent = await t.fetch(`/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'follow-up reply', replyToMessageId: target.id })
      });
      expect(sent.status).toBe(200);

      const replyEvent = (await createdReply).find(
        (event) =>
          event.type === 'session.message.created' &&
          parseEventPayload('session.message.created', event.payload).message.text === 'follow-up reply'
      );
      if (replyEvent?.type !== 'session.message.created') throw new Error('canonical reply event missing');
      const replyPayload = parseEventPayload('session.message.created', replyEvent.payload);
      expect({ id: replyPayload.message.id, replyToMessageId: replyPayload.message.replyToMessageId }).toEqual({
        id: expect.stringMatching(/^msg_/),
        replyToMessageId: target.id
      });

      let history: ChatMessage[] = [];
      await waitFor(
        async () => {
          history = (
            (await (await t.fetch(`/v1/sessions/${sessionId}/messages`)).json()) as {
              messages: ChatMessage[];
            }
          ).messages;
          return history.length === 4;
        },
        { intervalMs: 5, message: 'reply round never reached 4 persisted messages' }
      );
      const reply = history[2];
      if (!reply) throw new Error('canonical user reply missing from history');
      expect(history.map(({ id, replyToMessageId, role, text }) => ({ id, replyToMessageId, role, text }))).toEqual([
        { id: expect.stringMatching(/^msg_/), replyToMessageId: undefined, role: 'user', text: 'original question' },
        { id: target.id, replyToMessageId: undefined, role: 'assistant', text: 'Hello world' },
        { id: reply.id, replyToMessageId: target.id, role: 'user', text: 'follow-up reply' },
        { id: expect.stringMatching(/^msg_/), replyToMessageId: undefined, role: 'assistant', text: 'Hello world' }
      ]);
    });

    test('reply target failures expose stable non-disclosing HTTP contracts', async () => {
      const sessionId = await createSession('reply-errors');
      const postReply = (replyToMessageId: MessageId) =>
        t.fetch(`/v1/sessions/${sessionId}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: 'reply', generate: false, replyToMessageId })
        });

      const missing = await postReply(newId('msg'));
      expect({ status: missing.status, body: canonicalHttpError(await missing.json()) }).toEqual({
        status: 404,
        body: replyTargetNotFoundError
      });

      await t.fetch(`/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '/help' })
      });
      const commandHistory = (await (await t.fetch(`/v1/sessions/${sessionId}/messages`)).json()) as {
        messages: ChatMessage[];
      };
      const directive = commandHistory.messages.find((message) => message.role === 'user' && message.text === '/help');
      if (!directive) throw new Error('command directive target missing');
      const invalid = await postReply(directive.id);
      expect({ status: invalid.status, body: canonicalHttpError(await invalid.json()) }).toEqual({
        status: 400,
        body: requestValidationError
      });

      await t.fetch(`/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'keep', generate: false })
      });
      await t.fetch(`/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hide', generate: false })
      });
      const beforeRestore = (await (await t.fetch(`/v1/sessions/${sessionId}/messages`)).json()) as {
        messages: ChatMessage[];
      };
      const keep = beforeRestore.messages.find((message) => message.text === 'keep');
      const hidden = beforeRestore.messages.find((message) => message.text === 'hide');
      if (!keep || !hidden) throw new Error('restore targets missing');
      await t.fetch(`/v1/sessions/${sessionId}/restore`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toMessageId: keep.id })
      });
      const inactive = await postReply(hidden.id);
      expect({ status: inactive.status, body: canonicalHttpError(await inactive.json()) }).toEqual({
        status: 404,
        body: replyTargetNotFoundError
      });
    });

    test('ordinary SSE replies validate targets before streaming and persist a valid relation once', async () => {
      const handlers = buildHandlers(mockModel(['streamed answer']));
      const inlineTransport = serveTransport(kind, createHttpTransport(handlers));

      try {
        const createInlineSession = async (title: string): Promise<SessionId> => {
          const response = await inlineTransport.fetch('/v1/sessions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title })
          });
          return ((await response.json()) as { sessionId: SessionId }).sessionId;
        };
        const sessionId = await createInlineSession(`ordinary SSE replies ${kind}`);
        const otherSessionId = await createInlineSession(`ordinary SSE cross target ${kind}`);
        const validTargetId = newId('msg');
        const inactiveTargetId = newId('msg');
        const crossTranscriptTargetId = newId('msg');
        const pendingTargetId = newId('msg');
        const directiveTargetId = newId('msg');
        const createdAt = '2026-07-21T00:00:00.000Z';

        handlers.store.insertMessage(validTargetId, sessionId, 'valid target', createdAt);
        handlers.store.insertMessage(inactiveTargetId, sessionId, 'inactive target', createdAt);
        handlers.store.removeMessage({
          transcriptTargetId: sessionId,
          messageId: inactiveTargetId,
          idempotencyKey: newId('idem'),
          fingerprint: 'ordinary-sse-inactive-target',
          updatedAt: '2026-07-21T00:00:01.000Z'
        });
        handlers.store.insertMessage(crossTranscriptTargetId, otherSessionId, 'cross target', createdAt);
        handlers.store.insertMessage(pendingTargetId, sessionId, 'pending target', createdAt, 'assistant', {
          streamStatus: 'pending'
        });
        handlers.store.insertMessage(directiveTargetId, sessionId, 'directive target', createdAt, 'assistant', {
          type: 'directive'
        });

        const failureCases = [
          {
            name: 'missing',
            replyToMessageId: newId('msg'),
            status: 404,
            body: replyTargetNotFoundError
          },
          {
            name: 'inactive',
            replyToMessageId: inactiveTargetId,
            status: 404,
            body: replyTargetNotFoundError
          },
          {
            name: 'cross-transcript',
            replyToMessageId: crossTranscriptTargetId,
            status: 404,
            body: replyTargetNotFoundError
          },
          {
            name: 'nonterminal',
            replyToMessageId: pendingTargetId,
            status: 400,
            body: requestValidationError
          },
          {
            name: 'nonreplyable',
            replyToMessageId: directiveTargetId,
            status: 400,
            body: requestValidationError
          }
        ] as const;
        const failures = await Promise.all(
          failureCases.map(async ({ name, replyToMessageId }) => {
            const response = await inlineTransport.fetch(`/v1/sessions/${sessionId}/messages`, {
              method: 'POST',
              headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
              body: JSON.stringify({ text: `reply to ${name}`, replyToMessageId })
            });
            const contentType = response.headers.get('content-type')?.split(';')[0] ?? null;
            const body = contentType === 'application/json' ? canonicalHttpError(await response.json()) : null;
            if (contentType !== 'application/json') await response.body?.cancel().catch(() => {});
            return { name, status: response.status, contentType, body };
          })
        );
        expect(failures).toEqual(
          failureCases.map(({ name, status, body }) => ({ name, status, contentType: 'application/json', body }))
        );

        const streamed = await inlineTransport.fetch(`/v1/sessions/${sessionId}/messages`, {
          method: 'POST',
          headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
          body: JSON.stringify({ text: 'valid ordinary reply', replyToMessageId: validTargetId })
        });
        const rawStream = await streamed.text();
        const events = rawStream
          .split('\n\n')
          .map((frame) => frame.split('\n').find((line) => line.startsWith('data: ')))
          .filter((line): line is string => line !== undefined)
          .map((line) => eventSchema.parse(JSON.parse(line.slice(6))));
        const createdReplies = events
          .filter((event) => event.type === 'session.message.created')
          .map((event) => parseEventPayload('session.message.created', event.payload).message)
          .filter((message) => message.text === 'valid ordinary reply');
        expect({ status: streamed.status, contentType: streamed.headers.get('content-type')?.split(';')[0] }).toEqual({
          status: 200,
          contentType: 'text/event-stream'
        });
        expect(
          createdReplies.map(({ id, role, text, replyToMessageId }) => ({ id, role, text, replyToMessageId }))
        ).toEqual([
          {
            id: expect.stringMatching(/^msg_/),
            role: 'user',
            text: 'valid ordinary reply',
            replyToMessageId: validTargetId
          }
        ]);
        const createdReply = createdReplies[0];
        if (!createdReply) throw new Error('ordinary SSE reply was not created');
        expect(
          events
            .filter((event) => event.type === 'session.message.delta.appended')
            .map((event) => parseEventPayload('session.message.delta.appended', event.payload).delta)
            .join('')
        ).toBe('streamed answer');
        expect(
          handlers.store
            .listMessages(sessionId)
            .filter(
              (message) =>
                message.id === createdReply.id || (message.role === 'assistant' && message.text === 'streamed answer')
            )
            .map(({ id, role, text, replyToMessageId }) => ({ id, role, text, replyToMessageId }))
        ).toEqual([
          {
            id: createdReply.id,
            role: 'user',
            text: 'valid ordinary reply',
            replyToMessageId: validTargetId
          },
          {
            id: expect.stringMatching(/^msg_/),
            role: 'assistant',
            text: 'streamed answer',
            replyToMessageId: undefined
          }
        ]);
      } finally {
        await inlineTransport.stop();
        handlers.store.close();
      }
    });

    test('ordinary SSE waits for authoritative ingress reply validation before sending headers', async () => {
      const store = createStore();
      const ingress = createMessageIngress({ store, bus: new EventBus() });
      let gate = createGate();
      const messageRepo: MessageRepo = {
        publishesCanonicalEvents: true,
        list: (sessionId) => store.listMessages(sessionId),
        append: async (message, options) => {
          if (message.role === 'user' && message.replyToMessageId) {
            const currentGate = gate;
            currentGate.markStarted();
            await currentGate.released;
          }
          await ingress.commit(
            {
              message: {
                id: messageIdSchema.parse(message.id),
                sessionId: message.sessionId,
                role: message.role,
                text: message.text,
                type: message.type ?? 'text',
                ...(message.data === undefined ? {} : { data: message.data }),
                ...(message.replyToMessageId === undefined ? {} : { replyToMessageId: message.replyToMessageId }),
                stream: { status: message.role === 'assistant' ? 'complete' : 'settled' },
                active: true,
                ...(message.includeInContext === undefined ? {} : { includeInContext: message.includeInContext }),
                createdAt: message.createdAt
              },
              idempotencyKey: messageIdempotencyKey('ordinary-sse-ingress-race', message.sessionId, message.id),
              producer: { kind: 'system', subsystem: 'agent-loop' }
            },
            options
          );
        }
      };
      const handlers = buildHandlers(mockModel(['unused']), undefined, { messageRepo, store });
      const inlineTransport = serveTransport(kind, createHttpTransport(handlers));

      try {
        const created = await inlineTransport.fetch('/v1/sessions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: `ordinary SSE ingress race ${kind}` })
        });
        const sessionId = ((await created.json()) as { sessionId: SessionId }).sessionId;
        const cases = [
          {
            name: 'inactive-after-preflight',
            status: 404,
            body: replyTargetNotFoundError,
            invalidate(targetId: MessageId) {
              store.removeMessage({
                transcriptTargetId: sessionId,
                messageId: targetId,
                idempotencyKey: newId('idem'),
                fingerprint: 'ordinary-sse-ingress-remove',
                updatedAt: '2026-07-21T00:00:01.000Z'
              });
            }
          },
          {
            name: 'nonreplyable-after-preflight',
            status: 400,
            body: requestValidationError,
            invalidate(targetId: MessageId) {
              store.updateMessage({
                transcriptTargetId: sessionId,
                messageId: targetId,
                idempotencyKey: newId('idem'),
                fingerprint: 'ordinary-sse-ingress-update',
                updatedAt: '2026-07-21T00:00:02.000Z',
                updates: { type: 'directive' }
              });
            }
          }
        ] as const;
        const results: Array<{ name: string; status: number; contentType: string | null; body: unknown }> = [];

        for (const race of cases) {
          const targetId = newId('msg');
          const replyText = `reply ${race.name}`;
          store.insertMessage(targetId, sessionId, race.name, '2026-07-21T00:00:00.000Z');
          const responsePromise = inlineTransport.fetch(`/v1/sessions/${sessionId}/messages`, {
            method: 'POST',
            headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
            body: JSON.stringify({ text: replyText, replyToMessageId: targetId })
          });
          await gate.started;
          race.invalidate(targetId);
          gate.release();
          const response = await responsePromise;
          const contentType = response.headers.get('content-type')?.split(';')[0] ?? null;
          const body = contentType === 'application/json' ? canonicalHttpError(await response.json()) : null;
          if (contentType !== 'application/json') await response.body?.cancel().catch(() => {});
          results.push({ name: race.name, status: response.status, contentType, body });
          expect(
            store
              .listMessages(sessionId, { includeInactive: true })
              .filter((message) => message.text === replyText)
              .map(({ id, replyToMessageId, text }) => ({ id, replyToMessageId, text }))
          ).toEqual([]);
          gate = createGate();
        }

        expect(results).toEqual(
          cases.map(({ name, status, body }) => ({ name, status, contentType: 'application/json', body }))
        );
      } finally {
        await inlineTransport.stop();
        store.close();
      }
    });

    test('active steer rejects reply relations with the same stable HTTP contract', async () => {
      let markStarted: (() => void) | undefined;
      let release: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const activeModel: ModelRouter = {
        async *stream() {
          markStarted?.();
          yield { type: 'text' as const, token: 'working' };
          await released;
          yield { type: 'text' as const, token: ' done' };
        },
        async complete() {
          return { finishReason: 'stop', text: 'working done' };
        }
      };
      const activeTransport = serveTransport(kind, createHttpTransport(buildHandlers(activeModel)));

      try {
        const created = await activeTransport.fetch('/v1/sessions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: `active reply steer ${kind}` })
        });
        const sessionId = ((await created.json()) as { sessionId: SessionId }).sessionId;
        await activeTransport.fetch(`/v1/sessions/${sessionId}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: 'reply target', generate: false })
        });
        const before = (await (await activeTransport.fetch(`/v1/sessions/${sessionId}/messages`)).json()) as {
          messages: ChatMessage[];
        };
        const target = before.messages[0];
        if (!target) throw new Error('expected active-steer reply target');

        const active = await activeTransport.fetch(`/v1/sessions/${sessionId}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: 'long running turn' })
        });
        expect(active.status).toBe(200);
        await started;

        const rejected = await activeTransport.fetch(`/v1/sessions/${sessionId}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: 'redirect', steer: true, replyToMessageId: target.id })
        });
        expect({ status: rejected.status, body: canonicalHttpError(await rejected.json()) }).toEqual({
          status: 400,
          body: requestValidationError
        });

        const blockResults = await Promise.all(
          [
            { text: 'blocked steer', steer: true },
            { text: '', continueFromHistory: true }
          ].map(async (control) => {
            const response = await activeTransport.fetch(`/v1/sessions/${sessionId}/messages/block`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ ...control, replyToMessageId: target.id })
            });
            return { status: response.status, body: canonicalHttpError(await response.json()) };
          })
        );
        expect(blockResults).toEqual([
          {
            status: 400,
            body: requestValidationError
          },
          {
            status: 400,
            body: requestValidationError
          }
        ]);

        const inlineHistory = await activeTransport.fetch(`/v1/sessions/${sessionId}/messages`, {
          method: 'POST',
          headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
          body: JSON.stringify({
            text: '',
            continueFromHistory: true,
            replyToMessageId: target.id
          })
        });
        const inlineContentType = inlineHistory.headers.get('content-type') ?? '';
        expect({
          status: inlineHistory.status,
          body: inlineContentType.includes('application/json') ? canonicalHttpError(await inlineHistory.json()) : null
        }).toEqual({
          status: 400,
          body: requestValidationError
        });
      } finally {
        release?.();
        await activeTransport.stop();
      }
    });

    test('a compacted prompt keeps only reply ids until message_retrieve fetches the target', async () => {
      const store = createStore();
      const requestSnapshots: string[] = [];
      let modelStep = 0;
      let targetId: MessageId | undefined;
      const model: ModelRouter = {
        async *stream(request) {
          requestSnapshots.push(JSON.stringify(request.messages));
          if (modelStep++ === 0) {
            if (!targetId) throw new Error('target id was not initialized');
            yield {
              type: 'tool-call' as const,
              call: {
                toolCallId: 'call_retrieve_reply_target',
                toolName: 'message_retrieve',
                input: { messageId: targetId }
              }
            };
            return;
          }
          yield { type: 'text' as const, token: 'Retrieved the compacted target.' };
        },
        async complete(request) {
          requestSnapshots.push(JSON.stringify(request.messages));
          if (modelStep++ === 0) {
            if (!targetId) throw new Error('target id was not initialized');
            return {
              finishReason: 'tool-calls' as const,
              text: '',
              toolCalls: [
                {
                  toolCallId: 'call_retrieve_reply_target',
                  toolName: 'message_retrieve',
                  input: { messageId: targetId }
                }
              ]
            };
          }
          return { finishReason: 'stop' as const, text: 'Retrieved the compacted target.' };
        }
      };
      const lookup = new MessageLookup(
        store,
        ({ actor, transcriptTargetId }) => actor.kind === 'daemon-agent' && actor.sessionId === transcriptTargetId
      );
      const compacted = {
        assemble: async (sessionId: string) => ({
          summary: 'Older messages were compacted.',
          messages: replayHistory(store.listMessages(sessionId).filter((message) => message.id !== targetId))
        })
      };
      const handlers = buildHandlers(model, undefined, {
        history: compacted as never,
        store,
        tools: [createMessageRetrieveTool(lookup)]
      });
      const compactedTransport = serveTransport(kind, createHttpTransport(handlers));
      try {
        const sessionResponse = await compactedTransport.fetch('/v1/sessions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'compacted reply retrieval' })
        });
        const sessionId = ((await sessionResponse.json()) as { sessionId: SessionId }).sessionId;
        const createdAt = '2026-07-21T00:00:00.000Z';
        targetId = newId('msg');
        const replyId = newId('msg');
        const target: ChatMessage = {
          id: targetId,
          sessionId,
          role: 'assistant',
          text: 'confidential target available only by authorized retrieval',
          type: 'text',
          stream: { status: 'settled' },
          active: true,
          createdAt
        };
        const reply: ChatMessage = {
          ...target,
          id: replyId,
          role: 'user',
          text: 'reply whose target was compacted away',
          replyToMessageId: targetId,
          createdAt: '2026-07-21T00:00:01.000Z'
        };
        store.createMessage({ message: target, idempotencyKey: newId('idem'), fingerprint: 'e2e:target:v1' });
        store.createMessage({ message: reply, idempotencyKey: newId('idem'), fingerprint: 'e2e:reply:v1' });

        const response = await compactedTransport.fetch(`/v1/sessions/${sessionId}/messages/block`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: 'retrieve the target now' })
        });
        expect(response.status).toBe(200);
        expect(((await response.json()) as { message: ChatMessage }).message.text).toBe(
          'Retrieved the compacted target.'
        );

        const firstPrompt = requestSnapshots[0] ?? '';
        const afterRetrieval = requestSnapshots[1] ?? '';
        expect({
          firstPromptHasReplyId: firstPrompt.includes(`[Monad message: id=${replyId} reply_to=${targetId}]`),
          firstPromptHasTargetText: firstPrompt.includes(target.text),
          retrievedPromptHasTarget: afterRetrieval.includes(target.text)
        }).toEqual({
          firstPromptHasReplyId: true,
          firstPromptHasTargetText: false,
          retrievedPromptHasTarget: true
        });
      } finally {
        await compactedTransport.stop();
        store.close();
      }
    });

    test('resume: reconnecting with Last-Event-ID delivers the final message without duplicating seen events', async () => {
      const sessionId = await createSession('resume');

      // Reader A: attach, send, then bail out after the 2nd token (mid-stream).
      const gate = connectionGate();
      const firstLeg = t.sse(`/v1/sessions/${sessionId}/events`, {
        until: (e) =>
          e.type === 'session.message.delta.appended' &&
          parseEventPayload('session.message.delta.appended', e.payload).index === 1,
        timeoutMs: 3000,
        onConnected: gate.onConnected
      });
      await gate.ready;
      await send(sessionId, 'hi');
      const seenA = await firstLeg;
      const cursor = seenA[seenA.length - 1]?.id;
      expect(cursor).toMatch(/^evt_/);

      // Reader B: resume from the cursor; must reach the completed message.
      const seenB = await t.sse(`/v1/sessions/${sessionId}/events`, {
        headers: { 'Last-Event-ID': cursor as string },
        until: (e) => e.type === 'session.message.completed',
        timeoutMs: 3000
      });

      // The terminal message is always delivered on resume, carrying the full text…
      const finalB = seenB.find((e) => e.type === 'session.message.completed');
      if (!finalB) throw new Error('missing completed message after resume');
      expect(parseEventPayload('session.message.completed', finalB.payload).message.text).toBe('Hello world');

      // …and token deltas are never gapped or duplicated across the reconnect: B's tokens
      // are exactly the ones A had not yet seen (resumed from the hot buffer), or none at
      // all (round already finished → recovered via the terminal message). Either way the
      // token streams are disjoint and together prefix the full reply.
      const tokenIndex = (e: Event) => parseEventPayload('session.message.delta.appended', e.payload).index;
      const aTokens = seenA.filter((e) => e.type === 'session.message.delta.appended').map(tokenIndex);
      const bTokens = seenB.filter((e) => e.type === 'session.message.delta.appended').map(tokenIndex);
      expect(aTokens).toEqual([0, 1]);
      expect(bTokens.some((i) => aTokens.includes(i))).toBe(false); // no duplicate tokens
      // contiguous: A's tokens then B's tokens form a gap-free prefix 0,1,2,…
      expect([...aTokens, ...bTokens]).toEqual(aTokens.concat(bTokens).map((_v, i) => i));
    });

    test('resume: an encoded scope-bound cur_ cursor is accepted and resumes from its durable anchor', async () => {
      const sessionId = await createSession('resume-cursor');

      // Round 1: run to completion so its terminal event is a durable anchor.
      const gate1 = connectionGate();
      const leg1 = t.sse(`/v1/sessions/${sessionId}/events`, {
        until: (e) => e.type === 'session.message.completed',
        timeoutMs: 5000,
        onConnected: gate1.onConnected
      });
      await gate1.ready;
      await send(sessionId, 'hi');
      const seen1 = await leg1;
      const anchorEvent = seen1.find((e) => e.type === 'session.message.completed');
      if (!anchorEvent) throw new Error('missing round-1 completed event');
      const token = encodeEventCursor({ plane: 'session.events', transcriptTargetId: sessionId }, anchorEvent.id);
      expect(token).toMatch(/^cur_/);

      // Resume with the encoded token (previously rejected at endpoint validation), then drive round 2.
      const gate2 = connectionGate();
      const leg2 = t.sse(`/v1/sessions/${sessionId}/events`, {
        headers: { 'Last-Event-ID': token },
        until: (e) => e.type === 'session.message.completed',
        timeoutMs: 5000,
        onConnected: gate2.onConnected
      });
      await gate2.ready;
      await send(sessionId, 'again');
      const seen2 = await leg2;

      // The token survived validation and resumed exclusively from its anchor: round 1's terminal event
      // is never re-delivered, and round 2's own terminal event arrives.
      const completed2 = seen2.filter((e) => e.type === 'session.message.completed').map((e) => e.id);
      expect(completed2).not.toContain(anchorEvent.id);
      expect(completed2.length).toBeGreaterThan(0);
    });

    test('resume: an expired encoded cur_ cursor is rejected with 410 on the events stream (durable replay truly cannot recover it)', async () => {
      const sessionId = await createSession('resume-expired');

      const eventsToken = encodeEventCursor({ plane: 'session.events', transcriptTargetId: sessionId }, newId('evt'));
      const eventsRes = await t.fetch(`/v1/sessions/${sessionId}/events`, {
        headers: { 'Last-Event-ID': eventsToken }
      });
      expect(eventsRes.status).toBe(410);
      await eventsRes.body?.cancel();
    });

    test('resume: an expired encoded cur_ cursor on ui-stream gets a 200 authoritative replacement snapshot, then the live tail continues', async () => {
      const sessionId = await createSession('resume-expired-ui');

      // Settle a real round first so the replacement snapshot has real content to prove it is
      // authoritative (not just a trivially-empty fresh session).
      const round1Res = await t.fetch(`/v1/sessions/${sessionId}/messages/block`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hi' })
      });
      expect(round1Res.status).toBe(200);
      const round1Message = ((await round1Res.json()) as { message: { id: string } }).message;
      const round1CanonicalRes = await t.fetch(`/v1/sessions/${sessionId}/messages`);
      const round1ExpectedIds = ((await round1CanonicalRes.json()) as { messages: Array<{ id: string }> }).messages.map(
        (m) => m.id
      );

      // A well-formed encoded cur_ token whose anchor was never durable in this session — the ui plane
      // must treat this as "stale cursor", not "state lost", per realtime-channels.md's replacement-
      // snapshot guarantee (message-generation and mesh-state already implement it; this closes the gap
      // where ui-stream was the one exception rejecting with 410 instead).
      const uiToken = encodeEventCursor({ plane: 'session.ui', transcriptTargetId: sessionId }, newId('evt'));
      const gate = connectionGate();
      const leg = t.sse(`/v1/sessions/${sessionId}/ui-stream`, {
        headers: { 'Last-Event-ID': uiToken },
        until: (e) => {
          const ev = e as unknown as SessionUiEvent;
          return (
            ev.kind === 'upsert' &&
            ev.item.kind === 'message' &&
            ev.item.role === 'assistant' &&
            ev.item.status === 'done'
          );
        },
        timeoutMs: 3000,
        onConnected: gate.onConnected
      });

      // Drive a second round while connected — the connection must not have terminated after the
      // snapshot; it keeps delivering the live tail.
      await gate.ready;
      const round2Res = await t.fetch(`/v1/sessions/${sessionId}/messages/block`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'again' })
      });
      expect(round2Res.status).toBe(200);
      const round2Message = ((await round2Res.json()) as { message: { id: string; text: string } }).message;

      const seen = await leg;
      const firstFrame = seen[0] as unknown as SessionUiEvent;
      if (firstFrame?.kind !== 'snapshot') throw new Error('expected a 200 replacement snapshot, not an error');
      // Authoritative: round 1's settled messages are present, exactly and in canonical order — not
      // silently skipped, dropped, or reordered.
      const snapshotMessageIds = firstFrame.items.filter((item) => item.kind === 'message').map((item) => item.id);
      expect(snapshotMessageIds).toEqual(round1ExpectedIds);
      expect(round1ExpectedIds).toContain(round1Message.id);

      // The live tail actually continued past the snapshot: round 2's OWN settled assistant message
      // (exact id, final text, done status) arrived as an upsert on the SAME connection, proving the
      // stream was not torn down after the replacement snapshot.
      const liveUpserts = seen
        .slice(1)
        .map((e) => e as unknown as SessionUiEvent)
        .filter((e): e is Extract<SessionUiEvent, { kind: 'upsert' }> => e.kind === 'upsert');
      const round2Upsert = liveUpserts.find(
        (e) => e.item.kind === 'message' && e.item.id === round2Message.id && e.item.status === 'done'
      );
      if (round2Upsert?.item.kind !== 'message') throw new Error('missing round-2 settled upsert on the live tail');
      expect(round2Upsert.item.parts).toEqual([{ type: 'text', text: round2Message.text }]);
    });

    for (const resumeVia of ['Last-Event-ID header', '?after= query'] as const) {
      test(`ui-stream resume via ${resumeVia}: reconnecting with a real anchor cursor after a second disconnected round reflects both rounds with no gap or duplicate`, async () => {
        const sessionId = await createSession('ui-resume');

        // Round 1: stay connected long enough to capture a REAL live cursor. An empty/settled-only
        // snapshot never carries one — the projector's cursor field is set exclusively by applyEvent()
        // on a LIVE bus event (ui-projection.ts:322-323), never by history hydration — so the only way
        // to obtain a resumable ui-stream cursor is to be connected while at least one live event
        // fires, mirroring exactly how the sibling /events resume test above captures its own anchor.
        const gate = connectionGate();
        const firstLeg = t.sse(`/v1/sessions/${sessionId}/ui-stream`, {
          until: (e) => {
            const ev = e as unknown as SessionUiEvent;
            return (
              ev.kind === 'upsert' &&
              ev.item.kind === 'message' &&
              ev.item.role === 'assistant' &&
              ev.item.status === 'done'
            );
          },
          timeoutMs: 3000,
          onConnected: gate.onConnected
        });
        await gate.ready;
        await send(sessionId, 'hi');
        const seenA = await firstLeg;
        const firstUpsert = seenA.find((e) => (e as unknown as SessionUiEvent).kind === 'upsert') as unknown as
          | SessionUiEvent
          | undefined;
        if (firstUpsert?.kind !== 'upsert') throw new Error('missing round-1 upsert event');
        const anchorCursor = firstUpsert.cursor as string;
        expect(anchorCursor).toMatch(/^evt_/);

        const round1MessagesRes = await t.fetch(`/v1/sessions/${sessionId}/messages`);
        const round1MessageIds = ((await round1MessagesRes.json()) as { messages: Array<{ id: string }> }).messages.map(
          (m) => m.id
        );
        expect(round1MessageIds.length).toBe(2); // user + assistant

        // Round 2 runs to completion with NO ui-stream subscriber attached — simulates a client that
        // stayed disconnected through the whole round, not just a brief gap.
        const round2Res = await t.fetch(`/v1/sessions/${sessionId}/messages/block`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: 'again' })
        });
        expect(round2Res.status).toBe(200);

        // Reconnect over real HTTP with round 1's anchor, via whichever resume mechanism this
        // iteration covers — the resumed snapshot must reflect BOTH rounds either way, proving the
        // buffered-tail-fold-into-snapshot path (messaging-subscribe.ts subscribeUi) actually runs
        // end-to-end over a live SSE reconnect, not just when the handler is called directly
        // in-process (subscribe-reconnect.test.ts only exercises the latter).
        const resumed = await (resumeVia === 'Last-Event-ID header'
          ? t.sse(`/v1/sessions/${sessionId}/ui-stream`, {
              headers: { 'Last-Event-ID': anchorCursor },
              until: () => true,
              timeoutMs: 3000
            })
          : t.sse(`/v1/sessions/${sessionId}/ui-stream?after=${encodeURIComponent(anchorCursor)}`, {
              until: () => true,
              timeoutMs: 3000
            }));
        const resumedSnapshot = resumed[0] as unknown as SessionUiEvent;
        if (resumedSnapshot?.kind !== 'snapshot') throw new Error('missing resumed ui snapshot');
        const resumedMessageIds = resumedSnapshot.items
          .filter((item) => item.kind === 'message')
          .map((item) => item.id);

        // Build the authoritative expected id order from canonical message history (chronological,
        // rowid ASC — the same order the projector's own hydration + live-apply produces) instead of a
        // length/Set.size proxy: this catches a wrong order, a missing id, or a duplicated id, none of
        // which a count-and-uniqueness check would.
        const canonicalMessagesRes = await t.fetch(`/v1/sessions/${sessionId}/messages`);
        const expectedMessageIds = (
          (await canonicalMessagesRes.json()) as { messages: Array<{ id: string }> }
        ).messages.map((m) => m.id);
        expect(resumedMessageIds).toEqual(expectedMessageIds);
      });
    }

    test('mesh-state stream: snapshot baseline, exclusive durable resume, and wrong-scope rejection', async () => {
      const handlers = buildHandlers(mockModel([]));
      const served = serveTransport(kind, createHttpTransport(handlers));
      const meshEvt = (sessionId: SessionId, type: Event['type'], meshSessionId: string): Event => ({
        id: newId('evt'),
        sessionId,
        type,
        actorAgentId: null,
        payload: { meshSessionId },
        at: new Date('2026-07-23T00:00:00.000Z').toISOString()
      });
      try {
        const { sessionId } = await handlers.session.create({ title: 'mesh-state' });
        const other = await handlers.session.create({ title: 'other' });
        const path = `/v1/sessions/${sessionId}/mesh-state/stream`;

        // Fresh subscribe delivers an authoritative snapshot first (no running mesh sessions yet).
        const fresh = (await served.sse(path, {
          until: () => true,
          timeoutMs: 3000
        })) as unknown as MeshAgentStateFrame[];
        expect(fresh[0]).toMatchObject({ kind: 'snapshot', sessions: [], loginRequirements: [], approvals: [] });

        // A known durable mesh anchor replays only its exclusive mesh tail, no snapshot.
        const anchor = meshEvt(sessionId, 'mesh.turn_settled', 'mesh_running0001');
        const next = meshEvt(sessionId, 'mesh.turn_started', 'mesh_running0001');
        handlers.store.appendEvents([anchor, next]);
        const resumed = (await served.sse(path, {
          headers: { 'Last-Event-ID': anchor.id },
          until: (frame) => (frame as unknown as MeshAgentStateFrame).kind === 'event',
          timeoutMs: 3000
        })) as unknown as MeshAgentStateFrame[];
        const replayedEventIds = resumed
          .filter((frame): frame is Extract<MeshAgentStateFrame, { kind: 'event' }> => frame.kind === 'event')
          .map((frame) => frame.event.id);
        expect(replayedEventIds).toEqual([next.id]);
        expect(resumed.some((frame) => frame.kind === 'snapshot')).toBe(false);

        // An absent (well-formed) anchor yields a replacement snapshot, not an error.
        const replacement = (await served.sse(`${path}?after=${newId('evt')}`, {
          until: () => true,
          timeoutMs: 3000
        })) as unknown as MeshAgentStateFrame[];
        expect(replacement[0]).toMatchObject({ kind: 'snapshot' });

        // A cross-session anchor is rejected with the public wrong-scope status before any stream opens.
        const foreign = meshEvt(other.sessionId, 'mesh.turn_started', 'mesh_running0002');
        handlers.store.appendEvents([foreign]);
        const rejected = await served.fetch(`${path}?after=${foreign.id}`);
        expect(rejected.status).toBe(409);
        await rejected.body?.cancel();
      } finally {
        await served.stop();
        handlers.store.close();
      }
    });

    test('POST /sessions/:id/reset clears messages, returns clearedCount, keeps the session', async () => {
      const sessionId = await createSession('reset-me');

      // Send a blocking round so there are messages to clear.
      await t.fetch(`/v1/sessions/${sessionId}/messages/block`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hello' })
      });

      // Confirm messages exist before reset.
      const before = await t.fetch(`/v1/sessions/${sessionId}/messages`);
      const { messages: beforeMsgs } = (await before.json()) as { messages: unknown[] };
      expect(beforeMsgs.length).toBeGreaterThan(0);

      // Reset: clear all messages + events.
      const res = await t.fetch(`/v1/sessions/${sessionId}/reset`, { method: 'POST' });
      expect(res.status).toBe(200);
      const { clearedCount } = (await res.json()) as { clearedCount: number };
      expect(clearedCount).toBeGreaterThan(0);

      // Session still exists but has no messages.
      const after = await t.fetch(`/v1/sessions/${sessionId}/messages`);
      const { messages: afterMsgs } = (await after.json()) as { messages: unknown[] };
      expect(afterMsgs).toHaveLength(0);
    });

    test('GET /workplace/projects/:id returns 404 for an unknown project', async () => {
      const res = await t.fetch('/v1/workplace/projects/prj_000000000000');
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string; code: string };
      expect(body.code).toBe('NOT_FOUND');
    });
  });
}
