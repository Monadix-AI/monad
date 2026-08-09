import type { AgentObservationEvent, SessionId } from '@monad/protocol';
import type { AgentObservationCard } from '../../../../../packages/atoms/src/agent-adapters/observation-cards.ts';
import type { RawFrameRow } from '../../../../../packages/atoms/src/workplace-experiences/chat-room/components/observation/raw-view.ts';
import type { ObservationPanelHooks } from '../../../../../packages/atoms/src/workplace-experiences/chat-room/components/observation/use-observation-panel.ts';
import type { Presence } from '../../../../../packages/atoms/src/workplace-experiences/experience/types.ts';

import { createMonadStore, createMonadTreatyClient } from '@monad/client-rtk';
import { meshSessionIdSchema, observationCursorSchema } from '@monad/protocol';
import {
  useGetMeshAgentConnectionQuery,
  useLazyGetMeshAgentConvenienceEventsQuery,
  useLazyGetMeshAgentRawEventsQuery,
  useStreamMeshAgentConvenienceQuery,
  useStreamMeshAgentRawQuery
} from '@monad/sdk-experience/react';
import { TooltipProvider } from '@monad/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';

import '../../../src/styles/globals.css';
import { builtinMeshAgentObservationAdapters } from '../../../../../packages/atoms/src/agent-adapters/observation-adapters.ts';
import { agentObservationCards } from '../../../../../packages/atoms/src/agent-adapters/observation-cards.ts';
import { configureBuiltinMeshAgentObservationAdapters } from '../../../../../packages/atoms/src/mesh-agent-observation-setup.ts';
import { AgentTasksRail } from '../../../../../packages/atoms/src/workplace-experiences/chat-room/components/agent-tasks-rail.tsx';
import { MonadMcpOutput } from '../../../../../packages/atoms/src/workplace-experiences/chat-room/components/observation/monad-mcp-output.tsx';
import { MeshAgentObservationPanel } from '../../../../../packages/atoms/src/workplace-experiences/chat-room/components/observation/panel.tsx';
import {
  RawObservationList,
  type RawObservationListHandle
} from '../../../../../packages/atoms/src/workplace-experiences/chat-room/components/observation/raw-observation-list.tsx';
import {
  projectSessionUiKey,
  useChatRoomExperienceStore
} from '../../../../../packages/atoms/src/workplace-experiences/chat-room/store.ts';
import { meshAgentNeutralStreamItems } from '../../../../../packages/atoms/src/workplace-experiences/experience/mesh-agent-observation/mesh-agent-observation.ts';

/**
 * Drives the REAL MeshAgentObservationPanel with a RawObservationList as its `content`, wired
 * through the same `contentControlRef` the panel forwards its Scroll-to-top button to. This is the
 * runtime coverage the SSR/pure-function unit tests cannot give: that the panel's top button
 * reaches the list's VirtualList scroll control, that the list spreads its control props into
 * VirtualList (so a jump-to-top fires `onLoadOlderEvents` exactly once), that a raw card body is
 * actually painted client-side, and that a prepended page does not chain-load.
 */

const LOREM =
  'Provider-native raw frame body. Exact bytes are shown verbatim in a preformatted block so the reader can inspect the unnormalized payload. ';

type FixtureProvider = 'claude-code' | 'codex';

let activeFixtureRequestCount: (() => number) | undefined;

configureBuiltinMeshAgentObservationAdapters();

function makeRow(index: number): RawFrameRow {
  return {
    identity: `raw_${index}`,
    cursor: `provider:raw_${index}`,
    stream: 'stdout',
    preview: `#${index} ${LOREM.repeat(3)}`
  };
}

function observationEvent(id: string, kind: AgentObservationEvent['kind'], text?: string): AgentObservationEvent {
  return {
    id,
    kind,
    streaming: false,
    ...(text ? { text } : {}),
    provenance: { contractEvents: [{ id, kind, text }] }
  };
}

function makeTurnEvents(agentKey: string, turn: number): AgentObservationEvent[] {
  const body = `${agentKey} turn ${turn} ${LOREM.repeat(turn % 3 === 0 ? 10 : 4)}`;
  return [
    observationEvent(`${agentKey}:turn-${turn}:start`, 'turn-start'),
    observationEvent(`${agentKey}:turn-${turn}:user`, 'user-message', `User request ${turn}`),
    observationEvent(`${agentKey}:turn-${turn}:assistant`, 'assistant-message', body),
    observationEvent(`${agentKey}:turn-${turn}:end`, 'turn-end')
  ];
}

function makeObservationItems(agentKey: string, count = 18): AgentObservationCard[] {
  return agentObservationCards(
    Array.from({ length: count }, (_, index) => {
      const events = makeTurnEvents(agentKey, index);
      return index === count - 1 ? events.slice(0, -1) : events;
    }).flat(),
    'codex'
  );
}

function ToolActivityFixture(): React.ReactElement {
  const events: AgentObservationEvent[] = [
    {
      id: 'tool-command-call',
      kind: 'tool-call',
      streaming: false,
      text: 'Tool call shell',
      tool: {
        callId: 'tool-command',
        input: { command: 'rg -n "ObservationToolCardShell" packages/atoms' },
        name: 'shell',
        status: 'completed'
      },
      provenance: { contractEvents: [{ id: 'raw-command-call' }] }
    },
    {
      id: 'tool-command-result',
      kind: 'tool-result',
      streaming: false,
      text: 'packages/atoms/src/workplace-experiences/chat-room/components/observation/card-shell.tsx:72',
      tool: {
        callId: 'tool-command',
        exitCode: 0,
        name: 'shell',
        output: '1 match in card-shell.tsx',
        status: 'completed'
      },
      provenance: { contractEvents: [{ id: 'raw-command-result' }] }
    },
    {
      id: 'tool-file-call',
      kind: 'tool-call',
      streaming: false,
      text: 'Tool call Read',
      tool: {
        callId: 'tool-file',
        input: { file_path: 'packages/ui/src/components/ObservationCard.tsx' },
        name: 'Read',
        status: 'completed'
      },
      provenance: { contractEvents: [{ id: 'raw-file-call' }] }
    },
    {
      id: 'tool-file-result',
      kind: 'tool-result',
      streaming: false,
      text: 'export function ObservationMeta() {}',
      tool: {
        callId: 'tool-file',
        name: 'Read',
        output: 'export function ObservationMeta() {}',
        status: 'completed'
      },
      provenance: { contractEvents: [{ id: 'raw-file-result' }] }
    },
    {
      id: 'tool-generic-call',
      kind: 'tool-call',
      streaming: false,
      text: 'Tool call codegraph_explore',
      tool: {
        callId: 'tool-generic',
        input: { query: 'observation tool card rendering' },
        name: 'codegraph_explore',
        status: 'completed'
      },
      provenance: { contractEvents: [{ id: 'raw-generic-call' }] }
    },
    {
      id: 'tool-generic-result',
      kind: 'tool-result',
      streaming: false,
      text: 'Found ObservationToolCardShell.',
      tool: {
        callId: 'tool-generic',
        name: 'codegraph_explore',
        output: 'Found ObservationToolCardShell.',
        status: 'completed'
      },
      provenance: { contractEvents: [{ id: 'raw-generic-result' }] }
    }
  ];
  const items = agentObservationCards(events, 'codex');
  return (
    <TooltipProvider>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
        <MeshAgentObservationPanel
          agentName="Tool Activity"
          eventsActive
          stream={{
            id: 'tool-activity',
            agentName: 'Tool Activity',
            provider: 'codex',
            tag: 'Agent',
            status: 'ok',
            output: '',
            items
          }}
        />
      </div>
    </TooltipProvider>
  );
}

function MonadOutputLayoutFixture(): React.ReactElement {
  return (
    <div className="w-180 p-8">
      <MonadMcpOutput
        completedLabel="Completed"
        emptyLabel="No details"
        falseLabel="No"
        inProgressLabel="In progress"
        output={{
          projectMemberId: 'pmem_xs41Tns4dcDb',
          sessionId: 'ses_9AqAd2FwdKK5',
          meshSessionId: 'mesh_oQhToS1rQuUw',
          runtime: {
            id: 'mesh_oQhToS1rQuUw',
            sessionId: 'ses_9AqAd2FwdKK5',
            agentName: 'pmem_xs41Tns4dcDb',
            provider: 'codex',
            productIcon: 'codex',
            workingPath: '/Users/zeke/Projects/monad',
            approvalOwnership: 'provider-owned',
            runtimeRole: 'managed-project-agent',
            lifecycle: { state: 'active' },
            capabilities: {
              input: false,
              steer: false,
              interrupt: false,
              approvalResolution: false
            }
          },
          provider: 'codex',
          workingPath: '/Users/zeke/Projects/monad'
        }}
        pendingLabel="Pending"
        planEmptyLabel="No todos yet"
        toolName="runtime_info"
        trueLabel="Yes"
      />
    </div>
  );
}

function MonadMessageBodyLayoutFixture(): React.ReactElement {
  return (
    <div className="w-180 p-8">
      <MonadMcpOutput
        completedLabel="Completed"
        emptyLabel="No details"
        falseLabel="No"
        inProgressLabel="In progress"
        output={{
          messages: [
            {
              text: 'Review the release notes before publishing.',
              messageId: 'message_44',
              createdAt: '2026-08-09T12:00:00.000Z',
              sender: { kind: 'human', name: 'Zeke' }
            }
          ]
        }}
        pendingLabel="Pending"
        planEmptyLabel="No todos yet"
        toolName="project_read"
        trueLabel="Yes"
      />
    </div>
  );
}

function fixtureCursor(pageIndex: number): `provider:fixture-page-${number}` {
  return `provider:fixture-page-${pageIndex}`;
}

function fixturePageIndex(cursor: string | undefined): number {
  const match = cursor?.match(/^provider:fixture-page-(\d+)$/);
  return match?.[1] ? Number.parseInt(match[1], 10) : 0;
}

function useFixtureRawEvents() {
  const [trigger] = useLazyGetMeshAgentRawEventsQuery();
  return [trigger] as const;
}

function useFixtureConvenienceEvents() {
  const [trigger] = useLazyGetMeshAgentConvenienceEventsQuery();
  return [trigger] as const;
}

function createFixtureRuntime(provider: FixtureProvider, meshSessionId: string, transcriptTargetId: SessionId) {
  const client = createMonadTreatyClient({ baseUrl: window.location.origin });
  const rawEvents = client.meshAgentRawEvents.bind(client);
  let convenienceRequestCount = 0;
  const adapter = builtinMeshAgentObservationAdapters.find((candidate) => candidate.provider === provider);
  if (!adapter?.observation) throw new Error(`missing fixture projector for ${provider}`);

  client.meshAgentConnection = async (id) => ({
    state: 'connected',
    meshSessionId: meshSessionIdSchema.parse(id),
    provider,
    observationEpoch: 'fixture-epoch',
    eventsBefore: fixtureCursor(0),
    revision: 1
  });
  client.streamMeshAgentConvenience = () => () => {};
  client.streamMeshAgentRaw = () => () => {};
  client.streamMeshAgentSessionUsage = () => () => {};
  client.meshAgentConvenienceEvents = async (id, targetId, request) => {
    const requestCursor = request.before ?? fixtureCursor(0);
    convenienceRequestCount += 1;
    const page = await rawEvents(id, targetId, {
      ...request,
      before: observationCursorSchema.parse(requestCursor)
    });
    const pageIndex = fixturePageIndex(requestCursor);
    const events = meshAgentNeutralStreamItems({
      id: `${id}@fixture-page-${pageIndex}`,
      provider,
      adapter,
      output: page.records.map((record) => JSON.stringify(record.data)).join('\n'),
      mode: 'events'
    });
    const cursor = observationCursorSchema.parse(request.before ?? fixtureCursor(0));
    return {
      frames:
        events.length > 0
          ? [
              {
                kind: 'patch' as const,
                cursor,
                operations: events.map((event) => ({ op: 'upsert' as const, event }))
              }
            ]
          : [],
      ...(page.nextCursor ? { nextCursor: observationCursorSchema.parse(page.nextCursor) } : {})
    };
  };

  const store = createMonadStore({ client });
  const projectId = 'prj_fixture00001';
  const uiKey = projectSessionUiKey(projectId, transcriptTargetId);
  useChatRoomExperienceStore.getState().followMeshSession(uiKey, projectId, meshSessionId);
  return { client, fixtureRequestCount: () => convenienceRequestCount, projectId, store, uiKey };
}

function FixtureObservationRail({
  presence,
  provider
}: {
  presence: Presence;
  provider: FixtureProvider;
}): React.ReactElement {
  const transcriptTargetId = 'ses_fixture00001' as SessionId;
  const meshSessionId = provider === 'codex' ? 'mesh_fixturecdx01' : 'mesh_fixturecla01';
  const runtime = useMemo(
    () => createFixtureRuntime(provider, meshSessionId, transcriptTargetId),
    [meshSessionId, provider, transcriptTargetId]
  );
  const dualObservationHooks = useMemo<ObservationPanelHooks>(
    () => ({
      useConnection: useGetMeshAgentConnectionQuery,
      useRawStream: useStreamMeshAgentRawQuery,
      useConvenienceStream: useStreamMeshAgentConvenienceQuery,
      useRawEvents: useFixtureRawEvents,
      useConvenienceEvents: useFixtureConvenienceEvents,
      useSessionUsage: () => ({
        currentData:
          provider === 'codex'
            ? {
                total: 600_426,
                input: 597_658,
                output: 2_768,
                cachedInput: 518_656,
                reasoningOutput: 845,
                context: { used: 72_693, window: 258_400 }
              }
            : { total: 30, input: 20, output: 10 }
      })
    }),
    [provider]
  );
  activeFixtureRequestCount = runtime.fixtureRequestCount;
  useEffect(
    () => () => {
      if (activeFixtureRequestCount === runtime.fixtureRequestCount) activeFixtureRequestCount = undefined;
      runtime.client.dispose();
      useChatRoomExperienceStore.getState().removeSessionUiState(runtime.uiKey);
    },
    [runtime]
  );
  const room = useMemo(
    () => ({
      activeSessionId: transcriptTargetId,
      dualObservationHooks,
      meshAgentStreams: [
        {
          id: meshSessionId,
          transcriptTargetId,
          agentName: 'Fixture Agent',
          provider,
          tag: 'Agent',
          status: 'ok' as const,
          output: '',
          items: []
        }
      ],
      projectId: runtime.projectId,
      railAgents: [
        {
          id: `fixture-agent-${provider}`,
          av: 'FA',
          name: 'Fixture Agent',
          kind: 'agent' as const,
          tag: 'Agent',
          presence,
          metadata: { agent: provider }
        }
      ],
      stopMeshAgent: () => {}
    }),
    [dualObservationHooks, meshSessionId, presence, provider, runtime.projectId, transcriptTargetId]
  );

  return (
    <Provider store={runtime.store}>
      <TooltipProvider delayDuration={0}>
        <div style={{ display: 'flex', height: '100vh', justifyContent: 'flex-end' }}>
          <AgentTasksRail room={room} />
        </div>
      </TooltipProvider>
    </Provider>
  );
}

declare global {
  interface Window {
    observationHarness: {
      agent: (agentKey: 'agent-a' | 'agent-b') => void;
      fixtureRequestCount: () => number;
      prependReset: () => void;
      state: () => {
        distanceFromBottom: number;
        loadCount: number;
        loadedTopRowOffset: number | null;
        loadingHeader: boolean;
        rowCount: number;
        bottomBodyText: string | null;
        scrollTop: number;
        topVisibleRowId: string | null;
      };
    };
  }
}

function Harness(): React.ReactElement {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get('mode');
  const providerValue = params.get('provider');
  const fixtureProvider: FixtureProvider = providerValue === 'claude-code' ? 'claude-code' : 'codex';
  const fixturePresence: Presence =
    params.get('presence') === 'sleeping'
      ? 'sleeping'
      : params.get('presence') === 'waking'
        ? 'waking'
        : params.get('presence') === 'idle'
          ? 'idle'
          : 'online';
  const [rows, setRows] = useState<RawFrameRow[]>(() => Array.from({ length: 24 }, (_, index) => makeRow(index)));
  const [agentKey, setAgentKey] = useState<'agent-a' | 'agent-b'>('agent-a');
  const [loadingOlder, setLoadingOlder] = useState(false);
  const rawRef = useRef<RawObservationListHandle>(null);
  const loadCountRef = useRef(0);
  const loadingRef = useRef(false);
  const nextPrependRef = useRef(-1);

  const onLoadOlderEvents = useCallback(() => {
    if (loadingRef.current || loadCountRef.current >= 5) return;
    loadingRef.current = true;
    setLoadingOlder(true);
    window.setTimeout(() => {
      loadCountRef.current += 1;
      setRows((previous) => {
        const older: RawFrameRow[] = [];
        for (let index = 0; index < 5; index += 1) {
          older.unshift(makeRow(nextPrependRef.current));
          nextPrependRef.current -= 1;
        }
        return [...older, ...previous];
      });
      loadingRef.current = false;
      setLoadingOlder(false);
    }, 150);
  }, []);

  window.observationHarness = {
    agent: setAgentKey,
    fixtureRequestCount: () => activeFixtureRequestCount?.() ?? 0,
    prependReset: () => {
      loadCountRef.current = 0;
    },
    state: () => {
      const scroller = document.querySelector<HTMLElement>('[role="log"]');
      const pres = [...document.querySelectorAll<HTMLElement>('[data-observation-raw-preview]')];
      const viewportTop = scroller?.getBoundingClientRect().top ?? 0;
      const loadedTopRow = scroller?.querySelector<HTMLElement>('[data-raw-card-id="raw_0"]');
      const topVisible = scroller
        ? [...scroller.querySelectorAll<HTMLElement>('[data-raw-card-id]')].find(
            (row) => row.getBoundingClientRect().bottom > viewportTop + 1
          )
        : undefined;
      return {
        distanceFromBottom: scroller
          ? Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight)
          : -1,
        loadCount: loadCountRef.current,
        loadedTopRowOffset: loadedTopRow ? Math.round(loadedTopRow.getBoundingClientRect().top - viewportTop) : null,
        loadingHeader: !!document.querySelector('[data-events-state="loading"]'),
        rowCount: pres.length,
        bottomBodyText: mode === 'fixture' ? null : (pres.at(-1)?.textContent ?? null),
        scrollTop: scroller ? Math.round(scroller.scrollTop) : -1,
        topVisibleRowId: topVisible?.dataset.rawCardId ?? null
      };
    }
  };

  if (mode === 'fixture')
    return (
      <FixtureObservationRail
        presence={fixturePresence}
        provider={fixtureProvider}
      />
    );
  if (mode === 'tool') return <ToolActivityFixture />;
  if (mode === 'monad-output') return <MonadOutputLayoutFixture />;
  if (mode === 'monad-message-body') return <MonadMessageBodyLayoutFixture />;

  if (mode === 'turn') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
        <MeshAgentObservationPanel
          agentName={agentKey === 'agent-a' ? 'Agent A' : 'Agent B'}
          canLoadOlderEvents={loadCountRef.current < 5}
          eventsActive
          loadingOlderEvents={loadingOlder}
          onLoadOlderEvents={onLoadOlderEvents}
          stream={{
            id: agentKey,
            agentName: agentKey === 'agent-a' ? 'Agent A' : 'Agent B',
            provider: 'codex',
            tag: 'Agent',
            status: 'ok',
            output: '',
            items: makeObservationItems(agentKey)
          }}
        />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <MeshAgentObservationPanel
        agentName="Observed Agent"
        canLoadOlderEvents={loadCountRef.current < 5}
        content={
          <RawObservationList
            canLoadOlderEvents={loadCountRef.current < 5}
            controlRef={rawRef}
            loadingOlderEvents={loadingOlder}
            onLoadOlderEvents={onLoadOlderEvents}
            rows={rows}
          />
        }
        contentControlRef={rawRef}
        contentHasItems
        loadingOlderEvents={loadingOlder}
        onLoadOlderEvents={onLoadOlderEvents}
      />
    </div>
  );
}

const container = document.getElementById('root');
if (container) createRoot(container).render(<Harness />);
