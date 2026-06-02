import type {
  Event,
  EventId,
  MeshAgentLoginRequirement,
  MeshAgentStateFrame,
  MeshSessionView,
  SessionId
} from '@monad/protocol';
import type { SessionContext } from '#/handlers/session/context.ts';

import { expect, test } from 'bun:test';
import { meshAgentStateLifecycleEventSchema, newId } from '@monad/protocol';

import { createMeshStateSubscribeHandler } from '#/handlers/session/handlers/mesh-state-subscribe.ts';
import { EventBus } from '#/services/event-bus.ts';
import { RoundCache } from '#/services/round-cache.ts';
import { createStore } from '#/store/db/index.ts';

const projectSessionId = newId('ses') as SessionId;
const otherProjectSessionId = newId('ses') as SessionId;
const runningMeshSessionId = newId('mesh');

const at = '2026-07-23T00:00:00.000Z';

function meshEvent(sessionId: SessionId, type: Event['type'], payload: Record<string, unknown>): Event {
  return { id: newId('evt'), sessionId, type, actorAgentId: null, payload, at };
}

// The frame's event field is the mesh-narrowed schema type; domain `Event` is structurally identical
// but nominally distinct, so bridge it the same way the handler does when asserting expected frames.
const evFrame = (event: Event): MeshAgentStateFrame => ({ kind: 'event', event }) as MeshAgentStateFrame;

const runningView: MeshSessionView = {
  id: runningMeshSessionId,
  sessionId: projectSessionId,
  agentName: 'codex',
  projectMemberId: null,
  provider: 'codex',
  productIcon: 'codex',
  workingPath: '/tmp/project',
  approvalOwnership: 'provider-owned',
  runtimeRole: 'interactive',
  agentRuntimeId: null,
  lastDeliveredSeq: 0,
  lastVisibleSeq: 0,
  pendingApprovalCount: 0,
  lifecycle: { state: 'active' },
  activity: { state: 'running', pid: 4242, queuedTurnCount: 0 },
  connection: { state: 'connected' },
  capabilities: {
    input: true,
    steer: true,
    interrupt: true,
    approvalResolution: true,
    providerSessionContinuation: true,
    runtimeRestoration: true,
    sessionReopen: true
  },
  providerSessionRef: null,
  startedAt: at,
  updatedAt: at
};
const { productIcon: _icon, ...runningSession } = runningView; // neutral projection (productIcon stripped)

interface HarnessOptions {
  sessions?: MeshSessionView[];
  loginRequirements?: MeshAgentLoginRequirement[];
  host?: boolean;
  seedDurable?: Event[];
  onSubscribed?: (api: { publish: (event: Event) => void }) => void;
}

function harness(opts: HarnessOptions = {}) {
  const store = createStore();
  const realBus = new EventBus();
  const cache = new RoundCache();
  if (opts.seedDurable) store.appendEvents(opts.seedDurable);
  const publish = (event: Event): void => {
    cache.append(event);
    realBus.publish(event);
  };
  const hostEnabled = opts.host ?? true;
  const bus = {
    subscribe(sessionId: string, sink: (event: Event) => void) {
      const dispose = realBus.subscribe(sessionId, sink);
      opts.onSubscribed?.({ publish });
      return dispose;
    }
  };
  const deps: Record<string, unknown> = { store, cache, bus };
  if (hostEnabled) {
    deps.meshAgentHost = {
      list: () => ({ sessions: opts.sessions ?? [] }),
      pendingLoginRequirements: () => opts.loginRequirements ?? []
    };
  }
  const ctx = { deps, requireSession: () => ({}) } as unknown as SessionContext;
  const { subscribeMeshState } = createMeshStateSubscribeHandler(ctx);
  return { subscribeMeshState, publish, store, cache };
}

/** The bootstrap advances only on consumer demand, so tests drive `pump()` the way the stream's
 *  `pull()` does — one bounded unit per call until it reports the subscription is live. */
function drain(subscription: { pump: () => 'more' | 'live' | 'overflow' }): void {
  let guard = 0;
  while (subscription.pump() === 'more') {
    if (++guard > 10_000) throw new Error('bootstrap pump did not settle');
  }
}

function collect(
  h: ReturnType<typeof harness>,
  args: { sessionId?: SessionId; afterEventId?: EventId } = {}
): MeshAgentStateFrame[] {
  const frames: MeshAgentStateFrame[] = [];
  const subscription = h.subscribeMeshState(
    {
      sessionId: args.sessionId ?? projectSessionId,
      ...(args.afterEventId ? { afterEventId: args.afterEventId } : {})
    },
    (frame) => frames.push(frame)
  );
  drain(subscription);
  subscription.dispose();
  return frames;
}

test('a mesh event racing the snapshot is covered by its cursor, not re-sent as a delta', () => {
  const turnStarted = meshEvent(projectSessionId, 'mesh.turn_started', { meshSessionId: runningMeshSessionId });
  const h = harness({ sessions: [runningView], onSubscribed: ({ publish }) => publish(turnStarted) });

  // The event is buffered before the snapshot is captured, so the snapshot cursor already accounts for
  // it; re-emitting it as a frame would double-apply on fold (or skip it on reconnect from the cursor).
  expect(collect(h)).toEqual([
    { kind: 'snapshot', cursor: turnStarted.id, sessions: [runningSession], loginRequirements: [], approvals: [] }
  ]);
});

test('a replacement snapshot carries a bounded recent sleep and wake history', () => {
  const unrelated = meshEvent(projectSessionId, 'mesh.turn_started', { meshSessionId: runningMeshSessionId });
  const asleep = meshEvent(projectSessionId, 'mesh.idle_suspended', {
    agentId: 'member-codex',
    agentName: 'Codex',
    type: 'idle_suspended',
    payload: { meshSessionId: runningMeshSessionId, idleTimeoutMs: 300_000 }
  });
  const awake = meshEvent(projectSessionId, 'mesh.idle_resumed', {
    agentId: 'member-codex',
    agentName: 'Codex',
    type: 'idle_resumed',
    payload: { meshSessionId: runningMeshSessionId }
  });
  const h = harness({ sessions: [runningView], seedDurable: [unrelated, asleep, awake] });
  const lifecycleEvents = [
    meshAgentStateLifecycleEventSchema.parse(asleep),
    meshAgentStateLifecycleEventSchema.parse(awake)
  ];

  expect(collect(h)).toEqual([
    {
      kind: 'snapshot',
      cursor: awake.id,
      sessions: [runningSession],
      loginRequirements: [],
      approvals: [],
      lifecycleEvents
    }
  ]);
});

test('an event published while the snapshot is emitted is flushed exactly once after it', () => {
  const later = meshEvent(projectSessionId, 'mesh.turn_started', { meshSessionId: runningMeshSessionId });
  const h = harness({ sessions: [runningView] });
  const frames: MeshAgentStateFrame[] = [];
  const subscription = h.subscribeMeshState({ sessionId: projectSessionId }, (frame) => {
    frames.push(frame);
    if (frame.kind === 'snapshot') h.publish(later); // reentrant publish during the snapshot sink
  });
  drain(subscription);
  subscription.dispose();

  expect(frames).toEqual([
    { kind: 'snapshot', sessions: [runningSession], loginRequirements: [], approvals: [] },
    evFrame(later)
  ]);
});

test('a throwing live sink disposes the subscription so no later event is delivered', () => {
  const first = meshEvent(projectSessionId, 'mesh.turn_started', { meshSessionId: runningMeshSessionId });
  const second = meshEvent(projectSessionId, 'mesh.turn_settled', { meshSessionId: runningMeshSessionId });
  const h = harness({ sessions: [runningView] });
  let liveDeliveries = 0;
  const subscription = h.subscribeMeshState({ sessionId: projectSessionId }, (frame) => {
    if (frame.kind !== 'event') return;
    liveDeliveries += 1;
    throw new Error('sink torn');
  });
  drain(subscription); // settle the bootstrap so the next publishes take the live path
  h.publish(first); // live sink throws → subscription disposed
  h.publish(second); // subscription gone → never delivered
  subscription.dispose();

  expect(liveDeliveries).toBe(1);
});

test('a known durable anchor replays only its exclusive mesh tail without a snapshot', () => {
  const roundOneTerminal = meshEvent(projectSessionId, 'mesh.turn_settled', { meshSessionId: runningMeshSessionId });
  const roundTwoStarted = meshEvent(projectSessionId, 'mesh.turn_started', { meshSessionId: runningMeshSessionId });
  const h = harness({ sessions: [runningView], seedDurable: [roundOneTerminal, roundTwoStarted] });

  expect(collect(h, { afterEventId: roundOneTerminal.id })).toEqual([evFrame(roundTwoStarted)]);
});

test('a durable tail longer than one replay page is streamed in order across page boundaries', () => {
  // More than one MESH_STATE_REPLAY_PAGE (256) of durable events: the resume must page the log rather
  // than materialise it whole, and every event must still arrive exactly once, in log order.
  const anchor = meshEvent(projectSessionId, 'mesh.turn_settled', { meshSessionId: runningMeshSessionId });
  const tail = Array.from({ length: 300 }, () =>
    meshEvent(projectSessionId, 'mesh.turn_started', { meshSessionId: runningMeshSessionId })
  );
  const h = harness({ sessions: [runningView], seedDurable: [anchor, ...tail] });

  const frames = collect(h, { afterEventId: anchor.id });
  expect({
    count: frames.length,
    allEventFrames: frames.every((frame) => frame.kind === 'event'),
    ids: frames.flatMap((frame) => (frame.kind === 'event' ? [frame.event.id] : []))
  }).toEqual({ count: 300, allEventFrames: true, ids: tail.map((event) => event.id) });
});

test('a live cache tail longer than one replay page is streamed in order across page boundaries', () => {
  const anchor = meshEvent(projectSessionId, 'mesh.turn_settled', { meshSessionId: runningMeshSessionId });
  const tail = Array.from({ length: 300 }, () =>
    meshEvent(projectSessionId, 'mesh.turn_started', { meshSessionId: runningMeshSessionId })
  );
  const h = harness({ sessions: [runningView] });
  h.publish(anchor);
  for (const event of tail) h.publish(event);

  const frames = collect(h, { afterEventId: anchor.id });
  expect({
    count: frames.length,
    allEventFrames: frames.every((frame) => frame.kind === 'event'),
    ids: frames.flatMap((frame) => (frame.kind === 'event' ? [frame.event.id] : []))
  }).toEqual({ count: 300, allEventFrames: true, ids: tail.map((event) => event.id) });
});

test('an absent well-formed anchor produces a replacement snapshot', () => {
  const login: MeshAgentLoginRequirement = {
    id: 'mesh-login:codex:codex',
    observedAt: at,
    agentName: 'codex',
    authAgentName: 'codex',
    provider: 'codex',
    reason: 'authentication required'
  };
  const h = harness({ sessions: [runningView], loginRequirements: [login] });

  expect(collect(h, { afterEventId: newId('evt') as EventId })).toEqual([
    { kind: 'snapshot', sessions: [runningSession], loginRequirements: [login], approvals: [] }
  ]);
});

test('an anchor belonging to another session is rejected as wrong-scope with no frames', () => {
  const foreign = meshEvent(otherProjectSessionId, 'mesh.turn_started', { meshSessionId: runningMeshSessionId });
  const h = harness({ sessions: [runningView], seedDurable: [foreign] });
  const frames: MeshAgentStateFrame[] = [];

  expect(() =>
    h.subscribeMeshState({ sessionId: projectSessionId, afterEventId: foreign.id }, (frame) => frames.push(frame))
  ).toThrow('event cursor has the wrong scope');
  // presence-ok: a rejected wrong-scope subscription must emit nothing before it throws
  expect(frames).toEqual([]);
});

test('an event present in both replay and the pending buffer is emitted exactly once', () => {
  const anchor = meshEvent(projectSessionId, 'mesh.turn_settled', { meshSessionId: runningMeshSessionId });
  const tail = meshEvent(projectSessionId, 'mesh.turn_started', { meshSessionId: runningMeshSessionId });
  const h = harness({
    sessions: [runningView],
    seedDurable: [anchor, tail],
    onSubscribed: ({ publish }) => publish(tail)
  });

  expect(collect(h, { afterEventId: anchor.id })).toEqual([evFrame(tail)]);
});

test('durable replay deduplicates only against the bounded live-pending window', () => {
  const anchor = meshEvent(projectSessionId, 'mesh.turn_settled', { meshSessionId: runningMeshSessionId });
  const tail = Array.from({ length: 500 }, () =>
    meshEvent(projectSessionId, 'mesh.turn_started', { meshSessionId: runningMeshSessionId })
  );
  const h = harness({
    sessions: [runningView],
    seedDurable: [anchor, ...tail],
    onSubscribed: ({ publish }) => {
      for (const event of tail) publish(event);
    }
  });

  expect(collect(h, { afterEventId: anchor.id })).toEqual(tail.map(evFrame));
});

test('a bootstrap live-pending overflow reports overflow and releases the subscription', () => {
  const live = Array.from({ length: 513 }, () =>
    meshEvent(projectSessionId, 'mesh.turn_started', { meshSessionId: runningMeshSessionId })
  );
  const h = harness({
    sessions: [runningView],
    onSubscribed: ({ publish }) => {
      for (const event of live) publish(event);
    }
  });
  const frames: MeshAgentStateFrame[] = [];
  const subscription = h.subscribeMeshState({ sessionId: projectSessionId }, (frame) => frames.push(frame));
  const result = subscription.pump();
  h.publish(meshEvent(projectSessionId, 'mesh.turn_settled', { meshSessionId: runningMeshSessionId }));
  subscription.dispose();

  // presence-ok: overflowing the bootstrap must terminate before emitting a partial baseline.
  expect({ result, frames }).toEqual({ result: 'overflow', frames: [] });
});

test('live mesh events after the baseline each deliver exactly once (bootstrap dedup set is not retained)', () => {
  // The bootstrap `seen` set only dedups the snapshot/replay baseline against events buffered during it;
  // once live it is cleared and no longer populated, so live delivery must not be suppressed or deduped
  // by it. Publish many unique live events and require every one through, in order, exactly once.
  const h = harness({ sessions: [runningView] });
  const frames: MeshAgentStateFrame[] = [];
  const subscription = h.subscribeMeshState({ sessionId: projectSessionId }, (frame) => frames.push(frame));
  drain(subscription); // settle the baseline first; these publishes then take the live path
  const live = [
    meshEvent(projectSessionId, 'mesh.turn_started', { meshSessionId: runningMeshSessionId }),
    meshEvent(projectSessionId, 'mesh.turn_settled', { meshSessionId: runningMeshSessionId }),
    meshEvent(projectSessionId, 'mesh.login_required', { agentName: 'codex', provider: 'codex', reason: 'sign in' }),
    meshEvent(projectSessionId, 'mesh.turn_started', { meshSessionId: runningMeshSessionId })
  ];
  for (const event of live) h.publish(event);
  subscription.dispose();

  expect(frames).toEqual([
    { kind: 'snapshot', sessions: [runningSession], loginRequirements: [], approvals: [] },
    ...live.map(evFrame)
  ]);
});

test('a non-mesh newest event sets the snapshot cursor but never becomes an event frame', () => {
  const chat = meshEvent(projectSessionId, 'session.message.created', {
    transcriptTargetId: projectSessionId,
    producer: { kind: 'user' },
    message: {
      id: newId('msg'),
      sessionId: projectSessionId,
      role: 'user',
      text: 'hi',
      type: 'text',
      stream: { status: 'settled' },
      active: true,
      createdAt: at
    },
    messageRevision: 1
  });
  const h = harness({ sessions: [runningView] });
  h.publish(chat); // newest accepted event before subscribe

  const frames: MeshAgentStateFrame[] = [];
  const subscription = h.subscribeMeshState({ sessionId: projectSessionId }, (frame) => frames.push(frame));
  drain(subscription); // the snapshot cursor is captured from the pre-subscribe chat event
  const mesh = meshEvent(projectSessionId, 'mesh.turn_started', { meshSessionId: runningMeshSessionId });
  h.publish(mesh);
  subscription.dispose();

  expect(frames).toEqual([
    { kind: 'snapshot', cursor: chat.id, sessions: [runningSession], loginRequirements: [], approvals: [] },
    evFrame(mesh)
  ]);
});

test('a subscription with no mesh agent host emits an unavailable frame and no subscription', () => {
  const h = harness({ host: false });

  expect(collect(h)).toEqual([{ kind: 'unavailable', reason: 'mesh-agent-service-unavailable' }]);
});
