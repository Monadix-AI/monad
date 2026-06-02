import type { UIItem } from '@monad/protocol';
import type { Participant } from '../../src/workplace-experiences/experience/types.ts';
import type { ProjectExperienceRuntimeSource } from '../../src/workplace-experiences/runtime.ts';

import { expect, test } from 'bun:test';

import { renderChatRoomWorkplaceExperience } from '../../src/workplace-experiences/chat-room/ui.tsx';
import { toChatRoomCanvas } from '../../src/workplace-experiences/chat-room/utils/canvas.ts';
import {
  requestSpawnAgentMemberDialog,
  spawnAgentMemberDialogRequest
} from '../../src/workplace-experiences/host-context.tsx';
import { createProjectExperienceRuntime } from '../../src/workplace-experiences/runtime.ts';

const participant = (
  id: string,
  kind: Participant['kind'],
  presence: Participant['presence'] = 'online'
): Participant => ({ id, av: id.slice(0, 2).toUpperCase(), name: id, kind, tag: 'AI', presence }) as Participant;

type RuntimeSourceOverrides = Partial<Omit<ProjectExperienceRuntimeSource, 'source'>> & {
  source?: Partial<ProjectExperienceRuntimeSource['source']>;
};

function runtimeSource(overrides: RuntimeSourceOverrides = {}): ProjectExperienceRuntimeSource {
  const base: ProjectExperienceRuntimeSource = {
    activeProjectId: null,
    activeSessionId: 'ses_project1PhWZ',
    ready: true,
    projectId: 'project-1',
    projects: [],
    participants: [participant('monad', 'agent')],
    projectMembers: [],
    availableProjectMembers: [],
    loadOlder: () => {},
    loadNewer: () => {},
    jumpToLive: () => {},
    transcriptMode: 'live',
    source: {
      transcriptItems: [],
      liveItems: [],
      liveTools: [],
      meshSessions: [],
      human: participant('you', 'human'),
      meshAgentAvatarSeeds: new Map(),
      meshAgentTags: new Map(),
      meshAgentDisplayNames: new Map(),
      showDeveloperOnlyMessages: false
    },
    modelProfiles: [],
    workdir: { path: undefined },
    paused: false,
    sendDirective: async () => {},
    resolveApproval: () => {},
    answerQuestion: () => {},
    pauseAll: () => {},
    addProjectMember: async () => {},
    removeProjectMember: async () => {},
    updateProjectMemberSettings: async () => {},
    sendMeshAgentInput: async () => {},
    stopMeshAgent: async () => {}
  };
  return { ...base, ...overrides, source: { ...base.source, ...overrides.source } };
}

test('toChatRoomCanvas: keeps project composer busy until live work and gates settle', () => {
  const streamingMessage: UIItem = {
    id: 'msg-live',
    kind: 'message',
    parts: [{ text: 'still streaming', type: 'text' }],
    replyable: false,
    role: 'assistant',
    seq: '1',
    status: 'streaming'
  };
  const runningTool: UIItem = {
    id: 'tool-live',
    kind: 'tool',
    seq: '2',
    status: 'running',
    tool: 'agent_acp_delegate'
  };
  const pendingApproval: UIItem = {
    id: 'approval-live',
    input: {},
    kind: 'approval',
    seq: '3',
    tool: 'shell'
  };

  expect(toChatRoomCanvas(runtimeSource()).busy).toBe(false);
  expect(toChatRoomCanvas(runtimeSource({ source: { liveItems: [streamingMessage] } })).busy).toBe(true);
  expect(toChatRoomCanvas(runtimeSource({ source: { liveItems: [runningTool] } })).busy).toBe(true);
  expect(toChatRoomCanvas(runtimeSource({ source: { liveItems: [pendingApproval] } })).busy).toBe(true);
  expect(
    toChatRoomCanvas(
      runtimeSource({
        source: {
          liveItems: [{ ...streamingMessage, status: 'done' }],
          liveTools: [{ ...runningTool, status: 'ok' }]
        }
      })
    ).busy
  ).toBe(false);
});

test('toChatRoomCanvas keeps detached history contiguous while retaining live control state', () => {
  const calls: string[] = [];
  const historySystem: UIItem = {
    id: 'system_HISTORY01',
    kind: 'system',
    level: 'error',
    seq: '0',
    text: 'historical gateway failure'
  };
  const historyMessage: UIItem = {
    id: 'msg_HISTORY00001',
    kind: 'message',
    parts: [{ text: 'detached history', type: 'text' }],
    replyable: true,
    role: 'user',
    seq: '1',
    status: 'done'
  };
  const liveMessage: UIItem = {
    id: 'msg_LIVETAIL0001',
    kind: 'message',
    parts: [{ text: 'unrelated live tail', type: 'text' }],
    replyable: false,
    role: 'assistant',
    seq: '9',
    status: 'streaming'
  };
  const liveSystem: UIItem = {
    id: 'system_LIVETAIL1',
    kind: 'system',
    seq: '10',
    text: 'unrelated live system event'
  };
  const canvas = toChatRoomCanvas(
    runtimeSource({
      jumpToLive: () => calls.push('jumpToLive'),
      loadNewer: () => calls.push('loadNewer'),
      transcriptMode: 'history',
      source: { transcriptItems: [historySystem, historyMessage], liveItems: [liveMessage, liveSystem] }
    })
  );

  canvas.loadNewer();
  canvas.jumpToLive();

  expect({
    busy: canvas.busy,
    calls,
    mode: canvas.transcriptMode,
    texts: canvas.messages.map((message) => message.text)
  }).toEqual({
    busy: true,
    calls: ['loadNewer', 'jumpToLive'],
    mode: 'history',
    texts: ['historical gateway failure', 'detached history']
  });
});

test('toChatRoomCanvas merges projected historical system items with the live tail', () => {
  const historicalSystem: UIItem = {
    id: 'system_HISTORY02',
    kind: 'system',
    level: 'error',
    seq: '1',
    text: 'older projected error'
  };
  const liveSystem: UIItem = {
    id: 'system_LIVE02',
    kind: 'system',
    seq: '2',
    text: 'current projected status'
  };

  const canvas = toChatRoomCanvas(
    runtimeSource({
      source: {
        transcriptItems: [historicalSystem],
        liveItems: [liveSystem]
      }
    })
  );

  expect(canvas.messages.map(({ id, systemTone, text }) => ({ id, systemTone, text }))).toEqual([
    { id: 'system_HISTORY02', systemTone: 'error', text: 'older projected error' },
    { id: 'system_LIVE02', systemTone: undefined, text: 'current projected status' }
  ]);
});

test('ChatRoomExperienceView: spawn member asks the host through the project dialog protocol', () => {
  const requests: unknown[] = [];

  requestSpawnAgentMemberDialog((request) => requests.push(request));

  expect(requests).toEqual([spawnAgentMemberDialogRequest]);
  expect(spawnAgentMemberDialogRequest).toEqual({
    intent: 'spawn-agent',
    open: true,
    type: 'project-settings'
  });
});

test('ChatRoomExperienceView: remounts session-local optimistic state when the routed session changes', () => {
  const first = createProjectExperienceRuntime(runtimeSource({ activeSessionId: 'ses_first111111' }), {
    switchExperience: () => {}
  });
  const second = createProjectExperienceRuntime(runtimeSource({ activeSessionId: 'ses_second22222' }), {
    switchExperience: () => {}
  });

  expect([
    renderChatRoomWorkplaceExperience({ runtime: first.views['chat-room'] }).key,
    renderChatRoomWorkplaceExperience({ runtime: second.views['chat-room'] }).key
  ]).toEqual(['chat-room:ses_first111111', 'chat-room:ses_second22222']);
});

test('createProjectExperienceRuntime: publishes an empty activity graph when live tools are absent', () => {
  const runtime = createProjectExperienceRuntime(runtimeSource({ source: { liveTools: undefined } }), {
    switchExperience: () => {}
  });

  expect(runtime.snapshot.graphCanvas?.activity).toEqual([]);
});

test('createProjectExperienceRuntime: exposes project data and controlled communication actions', () => {
  const calls: string[] = [];
  const source = runtimeSource({
    loadOlder: () => calls.push('loadOlder'),
    loadNewer: () => calls.push('loadNewer'),
    jumpToLive: () => calls.push('jumpToLive'),
    sendDirective: async (directive) => {
      calls.push(`send:${typeof directive === 'string' ? directive : directive.text}`);
    },
    resolveApproval: (id, decision) => calls.push(`approval:${id}:${decision}`),
    answerQuestion: (id: string, answer: string) => calls.push(`answer:${id}:${answer}`),
    pauseAll: () => calls.push('pauseAll'),
    sendMeshAgentInput: async (id: string, input: string) => {
      calls.push(`input:${id}:${input}`);
    },
    stopMeshAgent: async (id: string) => {
      calls.push(`stop:${id}`);
    }
  });

  const runtime = createProjectExperienceRuntime(source, { switchExperience: (id) => calls.push(`experience:${id}`) });
  const atomHostApi = {
    actions: runtime.actions,
    embedded: true,
    requestProjectDialog: () => {},
    snapshot: runtime.snapshot
  };

  expect(runtime.snapshot.projectId).toBe('project-1');
  expect('participants' in runtime.snapshot).toBe(false);
  expect('chatRoom' in atomHostApi).toBe(false);
  expect('graphicView' in atomHostApi).toBe(false);
  expect('composer' in atomHostApi).toBe(false);
  expect('chatRoom' in runtime).toBe(false);
  expect('graphicView' in runtime).toBe(false);
  expect('composer' in runtime).toBe(false);
  expect(runtime.views['chat-room'].canvas.participants).toHaveLength(1);
  expect(runtime.views['chat-room'].composer).not.toBe(runtime.views['chat-room'].canvas);
  expect(runtime.views['chat-room'].composer.participants).toHaveLength(1);
  expect('graphic-view' in runtime.views).toBe(false);
  expect(runtime.snapshot.graphCanvas?.participants).toHaveLength(1);
  expect(runtime.snapshot.graphCanvas?.activity).toEqual([]);
  expect('switchProject' in runtime.actions).toBe(false);

  runtime.actions.loadOlder();
  runtime.views['chat-room'].canvas.loadNewer();
  runtime.views['chat-room'].canvas.jumpToLive();
  void runtime.actions.sendDirective('hello');
  runtime.actions.resolveApproval('approval-1', 'approve-session');
  runtime.actions.switchExperience('kanban');
  runtime.views['chat-room'].composer.answerQuestion('question-1', 'answer');

  expect(calls).toEqual([
    'loadOlder',
    'loadNewer',
    'jumpToLive',
    'send:hello',
    'approval:approval-1:approve-session',
    'experience:kanban',
    'answer:question-1:answer'
  ]);
});
