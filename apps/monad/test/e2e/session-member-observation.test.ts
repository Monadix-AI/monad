// P5 (agent-observation-implementation-order.md): the monad built-in agent's own turn, observed as a
// project-session member through the same neutral AgentObservationEvent plane mesh-agent members
// already use (`/mesh/sessions/:id/events/convenience` and `/stream/convenience`) — here the session-member
// counterpart, GET /sessions/:id/members/:memberId/ui-observation{,-stream}. Over BOTH transports (TCP
// loopback + Unix socket), per the all-transports rule in AGENTS.md.

import type { AgentObservationEvent, SessionMemberUiObservationFrame } from '@monad/protocol';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createHttpTransport } from '#/transports/http.ts';
import { buildHandlers, mockModel, serveTransport, TRANSPORTS, type TransportHandle } from '../helpers.ts';

/** Narrows the discriminated frame union without a state check at every call site. */
function eventsOf(frame: SessionMemberUiObservationFrame): AgentObservationEvent[] {
  return frame.state === 'unavailable' ? [] : frame.events;
}

/** Reads SSE frames off `path` until `until` matches one, or `timeoutMs` elapses. Mirrors
 *  `readSSE` in `test/helpers.ts` (generic over the frame type rather than the domain `Event`). */
async function readFrames(
  t: TransportHandle,
  path: string,
  until: (frame: SessionMemberUiObservationFrame) => boolean,
  timeoutMs = 2000
): Promise<SessionMemberUiObservationFrame[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const seen: SessionMemberUiObservationFrame[] = [];
  try {
    const res = await t.fetch(path, { headers: { accept: 'text/event-stream' }, signal: controller.signal });
    const reader = res.body?.getReader();
    if (!reader) return seen;
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return seen;
      buf += decoder.decode(value, { stream: true });
      let sep = buf.indexOf('\n\n');
      while (sep !== -1) {
        const frameText = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const dataLine = frameText.split('\n').find((l) => l.startsWith('data: '));
        if (dataLine) {
          const frame = JSON.parse(dataLine.slice(6)) as SessionMemberUiObservationFrame;
          seen.push(frame);
          if (until(frame)) return seen;
        }
        sep = buf.indexOf('\n\n');
      }
    }
  } catch {
    // aborted (timeout or satisfied) — fall through to return what we collected
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return seen;
}

for (const kind of TRANSPORTS) {
  describe(`session member observation over ${kind}`, () => {
    let t: TransportHandle;

    beforeEach(() => {
      t = serveTransport(kind, createHttpTransport(buildHandlers(mockModel(['hello back']))));
    });
    afterEach(async () => {
      await t.stop();
    });

    const json = (method: string, path: string, body?: unknown) =>
      t.fetch(path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });

    async function createProjectSessionWithMonadMember(): Promise<{ sessionId: string; memberId: string }> {
      const { projectId } = (await (await json('POST', '/v1/workplace/projects', { title: 'p' })).json()) as {
        projectId: string;
      };
      const { sessionId } = (await (
        await json('POST', `/v1/projects/${projectId}/sessions`, { title: 's' })
      ).json()) as { sessionId: string };
      const { member } = (await (
        await json('POST', `/v1/sessions/${sessionId}/members`, { type: 'monad', name: 'monad' })
      ).json()) as { member: { id: string; type: string } };
      expect(member.type).toBe('monad');
      return { sessionId, memberId: member.id };
    }

    test('GET ui-observation 200s with an empty history frame before any turn', async () => {
      const { sessionId, memberId } = await createProjectSessionWithMonadMember();

      const res = await t.fetch(`/v1/sessions/${sessionId}/members/${memberId}/ui-observation`);
      expect(res.status).toBe(200);
      const frame = (await res.json()) as SessionMemberUiObservationFrame;
      expect(frame).toMatchObject({ state: 'events', sessionId, memberId, events: [] });
    });

    test('GET ui-observation projects the turn as neutral user-message/assistant-message events', async () => {
      const { sessionId, memberId } = await createProjectSessionWithMonadMember();

      const sendRes = await json('POST', `/v1/sessions/${sessionId}/messages/block`, { text: 'hi' });
      expect(sendRes.status).toBe(200);

      const res = await t.fetch(`/v1/sessions/${sessionId}/members/${memberId}/ui-observation`);
      const frame = (await res.json()) as SessionMemberUiObservationFrame;
      expect(frame.state).toBe('events');
      expect(eventsOf(frame)).toMatchObject([
        { kind: 'user-message', streaming: false, text: 'hi' },
        { kind: 'assistant-message', streaming: false, text: 'hello back' }
      ]);
    });

    test('GET ui-observation is unavailable for a non-monad or unknown member id', async () => {
      const { sessionId, memberId } = await createProjectSessionWithMonadMember();

      const { member: codexMember } = (await (
        await json('POST', `/v1/sessions/${sessionId}/members`, { type: 'mesh-agent', name: 'codex' })
      ).json()) as { member: { id: string } };

      const unknown = await t.fetch(`/v1/sessions/${sessionId}/members/does-not-exist/ui-observation`);
      expect(unknown.status).toBe(200);
      expect(((await unknown.json()) as SessionMemberUiObservationFrame).state).toBe('unavailable');

      const external = await t.fetch(`/v1/sessions/${sessionId}/members/${codexMember.id}/ui-observation`);
      expect(((await external.json()) as SessionMemberUiObservationFrame).state).toBe('unavailable');

      // The monad member is unaffected by the other member existing alongside it.
      const monad = await t.fetch(`/v1/sessions/${sessionId}/members/${memberId}/ui-observation`);
      expect(((await monad.json()) as SessionMemberUiObservationFrame).state).toBe('events');
    });

    test('ui-observation-stream pushes a live frame for a message sent after connecting', async () => {
      const { sessionId, memberId } = await createProjectSessionWithMonadMember();

      // The first frame is the initial (empty) snapshot on connect; wait for a live frame carrying
      // the user-message the turn below sends.
      const framesPromise = readFrames(
        t,
        `/v1/sessions/${sessionId}/members/${memberId}/ui-observation-stream`,
        (frame) => frame.state === 'live' && eventsOf(frame).some((e) => e.kind === 'user-message')
      );
      // Give the SSE subscription a moment to attach before the turn runs.
      await new Promise((resolve) => setTimeout(resolve, 50));
      await json('POST', `/v1/sessions/${sessionId}/messages/block`, { text: 'hi' });

      const frames = await framesPromise;
      expect(frames[0]).toMatchObject({ state: 'events', sessionId, memberId, events: [] });
      const live = frames.find((f) => f.state === 'live' && eventsOf(f).some((e) => e.kind === 'user-message'));
      expect(live).toMatchObject({ sessionId, memberId, events: [{ kind: 'user-message', text: 'hi' }] });
    });

    test('ui-observation-stream closes after a single frame for an unknown member', async () => {
      const { sessionId } = await createProjectSessionWithMonadMember();

      const frames = await readFrames(
        t,
        `/v1/sessions/${sessionId}/members/does-not-exist/ui-observation-stream`,
        () => true
      );
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({ state: 'unavailable', sessionId, memberId: 'does-not-exist' });
    });
  });
}
