import type {
  AgentObservationEvent,
  MeshConnectionSnapshot,
  MeshConvenienceEventPage,
  MeshConvenienceFrame,
  MeshRawEvent,
  MeshRawEventPage,
  SessionId
} from '@monad/protocol';
import type {
  ObservationPanelHooks,
  UseObservationPanelArgs
} from '../../src/workplace-experiences/chat-room/components/observation/use-observation-panel.ts';

import { expect, test } from 'bun:test';
import { act, renderHook } from '@testing-library/react';

import { useObservationPanel } from '../../src/workplace-experiences/chat-room/components/observation/use-observation-panel.ts';
import { setupDomTestEnvironment } from '../dom-test-env.ts';

setupDomTestEnvironment();

const transcriptTargetId = 'ses_observation01' as SessionId;

function event(id: string, text: string): AgentObservationEvent {
  return {
    id,
    kind: 'assistant-message',
    streaming: false,
    text,
    provenance: { contractEvents: [{ id }] }
  };
}

function connected(meshSessionId: `mesh_${string}`, epoch: string, revision: number): MeshConnectionSnapshot {
  return {
    state: 'connected',
    meshSessionId,
    provider: 'codex',
    observationEpoch: epoch,
    revision
  };
}

function disconnected(meshSessionId: `mesh_${string}`, revision: number): MeshConnectionSnapshot {
  return { state: 'disconnected', meshSessionId, revision };
}

function frames(epoch: string, observation: AgentObservationEvent): MeshConvenienceFrame[] {
  return [
    { kind: 'ready', observationEpoch: epoch, cursor: `live:${epoch}:0` },
    {
      kind: 'patch',
      cursor: `live:${epoch}:1`,
      operations: [{ op: 'upsert', event: observation }]
    }
  ];
}

function deferredPage(): {
  promise: Promise<MeshConvenienceEventPage>;
  resolve: (page: MeshConvenienceEventPage) => void;
} {
  let resolve!: (page: MeshConvenienceEventPage) => void;
  const promise = new Promise<MeshConvenienceEventPage>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

test('observation hook retains one agent plane through reconnect and clears it after empty replacement', async () => {
  const firstSessionId = 'mesh_observation01';
  const secondSessionId = 'mesh_observation02';
  const oldEvent = event('old', 'visible before wake');
  const newEvent = event('new', 'visible after wake');
  let snapshot = connected(firstSessionId, 'e1', 1);
  let convenienceFrames = frames('e1', oldEvent);
  const pendingPages: ReturnType<typeof deferredPage>[] = [];
  const hooks: ObservationPanelHooks = {
    useConnection: () => ({ currentData: snapshot, refetch: () => {} }),
    useRawStream: () => ({ currentData: { fatalError: false, frames: [], frameOffset: 0 } }),
    useConvenienceStream: () => ({
      currentData: { fatalError: false, frames: convenienceFrames, frameOffset: 0 }
    }),
    useRawEvents: () =>
      [
        () => ({
          unwrap: async (): Promise<MeshRawEventPage> => ({ coverage: 'exact', records: [] })
        })
      ] as const,
    useConvenienceEvents: () =>
      [
        () => ({
          unwrap: () => {
            const pending = pendingPages.shift();
            return pending ? pending.promise : Promise.resolve({ frames: [] });
          }
        })
      ] as const,
    useSessionUsage: () => ({})
  };

  const props = (meshSessionId: string): Omit<UseObservationPanelArgs, 'hooks'> => ({
    meshSessionId,
    transcriptTargetId,
    agentName: meshSessionId,
    provider: 'codex'
  });

  const rendered = renderHook(
    (input: Omit<UseObservationPanelArgs, 'hooks'>) => useObservationPanel({ ...input, hooks }),
    {
      initialProps: props(firstSessionId)
    }
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(rendered.result.current.events.map((item) => item.text)).toEqual(['visible before wake']);

  const reconnectPage = deferredPage();
  pendingPages.push(reconnectPage);
  snapshot = disconnected(firstSessionId, 2);
  convenienceFrames = [];
  await act(async () => {
    rendered.rerender(props(firstSessionId));
    await Promise.resolve();
  });
  expect({
    events: rendered.result.current.events.map((item) => item.text),
    loading: rendered.result.current.loading
  }).toEqual({ events: ['visible before wake'], loading: false });

  snapshot = connected(firstSessionId, 'e2', 3);
  convenienceFrames = frames('e2', newEvent);
  await act(async () => {
    rendered.rerender(props(firstSessionId));
    await Promise.resolve();
  });
  expect(rendered.result.current.events.map((item) => item.text)).toEqual(['visible after wake']);

  const emptyReplacement = deferredPage();
  pendingPages.push(emptyReplacement);
  snapshot = disconnected(firstSessionId, 4);
  convenienceFrames = [];
  await act(async () => {
    rendered.rerender(props(firstSessionId));
    await Promise.resolve();
  });
  expect(rendered.result.current.events.map((item) => item.text)).toEqual(['visible after wake']);
  await act(async () => {
    emptyReplacement.resolve({ frames: [] });
    await emptyReplacement.promise;
  });
  expect({ events: rendered.result.current.events, loading: rendered.result.current.loading }).toEqual({
    events: [],
    loading: false
  });

  const otherAgentPage = deferredPage();
  pendingPages.push(otherAgentPage);
  snapshot = disconnected(secondSessionId, 1);
  await act(async () => {
    rendered.rerender(props(secondSessionId));
    await Promise.resolve();
  });
  expect(rendered.result.current.events).toEqual([]);

  reconnectPage.resolve({ frames: [] });
  otherAgentPage.resolve({ frames: [] });
  await act(async () => {
    rendered.unmount();
    await Promise.all([reconnectPage.promise, otherAgentPage.promise]);
  });
});

test('observation hook preserves both planes through repeated activity and raw mode switches', async () => {
  const meshSessionId = 'mesh_observation_switches';
  const activityEvent = event('activity', 'activity survives');
  const snapshot = connected(meshSessionId, 'e1', 1);
  const rawFrame: MeshRawEvent = {
    meshSessionId,
    provider: 'codex',
    observationEpoch: 'e1',
    origin: 'live',
    cursor: 'live:e1:1',
    providerIdentity: 'raw-survives',
    stream: 'stdout',
    data: 'raw survives'
  };
  let convenienceFrames = frames('e1', activityEvent);
  let rawFrames = [rawFrame];
  const hooks: ObservationPanelHooks = {
    useConnection: () => ({ currentData: snapshot, refetch: () => {} }),
    useRawStream: () => ({ currentData: { fatalError: false, frames: rawFrames, frameOffset: 0 } }),
    useConvenienceStream: () => ({
      currentData: { fatalError: false, frames: convenienceFrames, frameOffset: 0 }
    }),
    useRawEvents: () =>
      [
        () => ({
          unwrap: async (): Promise<MeshRawEventPage> => ({ coverage: 'exact', records: [] })
        })
      ] as const,
    useConvenienceEvents: () =>
      [
        () => ({
          unwrap: async (): Promise<MeshConvenienceEventPage> => ({ frames: [] })
        })
      ] as const,
    useSessionUsage: () => ({})
  };

  const rendered = renderHook(() =>
    useObservationPanel({
      meshSessionId,
      transcriptTargetId,
      agentName: meshSessionId,
      provider: 'codex',
      hooks
    })
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(rendered.result.current.events.map((item) => item.text)).toEqual(['activity survives']);

  await act(async () => {
    rendered.result.current.setMode('raw');
    await Promise.resolve();
  });
  expect(rendered.result.current.rawRows.map((row) => row.preview)).toEqual(['raw survives']);

  convenienceFrames = [];
  rawFrames = [];
  for (let cycle = 0; cycle < 2; cycle += 1) {
    await act(async () => {
      rendered.result.current.setMode('convenience');
      await Promise.resolve();
    });
    expect({
      mode: rendered.result.current.mode,
      events: rendered.result.current.events.map((item) => item.text)
    }).toEqual({ mode: 'convenience', events: ['activity survives'] });

    await act(async () => {
      rendered.result.current.setMode('raw');
      await Promise.resolve();
    });
    expect({
      mode: rendered.result.current.mode,
      rawRows: rendered.result.current.rawRows.map((row) => row.preview)
    }).toEqual({ mode: 'raw', rawRows: ['raw survives'] });
  }

  await act(async () => {
    rendered.unmount();
    await Promise.resolve();
  });
});
