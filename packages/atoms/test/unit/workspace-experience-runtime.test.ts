import type { UIItem } from '@monad/protocol';
import type { Participant } from '../../src/workspace-experiences/experience/types.ts';
import type { ProjectExperienceRuntimeSource } from '../../src/workspace-experiences/runtime.ts';

import { expect, test } from 'bun:test';

import { renderChatRoomWorkspaceExperience } from '../../src/workspace-experiences/chat-room/ui.tsx';
import { toChatRoomCanvas } from '../../src/workspace-experiences/chat-room/utils/canvas.ts';
import {
  requestSpawnAgentMemberDialog,
  spawnAgentMemberDialogRequest
} from '../../src/workspace-experiences/host-context.tsx';
import { createProjectExperienceRuntime } from '../../src/workspace-experiences/runtime.ts';

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
    source: {
      transcriptItems: [],
      liveItems: [],
      liveTools: [],
      externalAgentSessions: [],
      human: participant('you', 'human'),
      externalAgentAvatarSeeds: new Map(),
      externalAgentTags: new Map(),
      externalAgentDisplayNames: new Map(),
      showDeveloperOnlyMessages: false
    },
    modelProfiles: [],
    workdir: { path: undefined, set: async () => {} },
    paused: false,
    sendDirective: async () => {},
    resolveApproval: () => {},
    answerQuestion: () => {},
    pauseAll: () => {},
    addProjectMember: async () => {},
    removeProjectMember: async () => {},
    updateProjectMemberSettings: async () => {},
    sendExternalAgentInput: async () => {},
    stopExternalAgent: async () => {}
  };
  return { ...base, ...overrides, source: { ...base.source, ...overrides.source } };
}

test('toChatRoomCanvas: exposes the chatroom surface without project management actions', () => {
  const canvas = toChatRoomCanvas(runtimeSource());

  expect(canvas.ready).toBe(true);
  expect(canvas.participants).toHaveLength(1);
  expect(canvas.railAgents).toHaveLength(1);
  expect(typeof canvas.sendDirective).toBe('function');
  expect(typeof canvas.resolveApproval).toBe('function');
  expect(typeof canvas.answerQuestion).toBe('function');
  expect(typeof canvas.sendExternalAgentInput).toBe('function');
  expect(typeof canvas.stopExternalAgent).toBe('function');
  for (const leaked of ['setWorkdir', 'switchProject', 'experience']) {
    expect(leaked in canvas).toBe(false);
  }
});

test('toChatRoomCanvas: keeps project composer busy until live work and gates settle', () => {
  const streamingMessage: UIItem = {
    id: 'msg-live',
    kind: 'message',
    parts: [{ text: 'still streaming', type: 'text' }],
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
    renderChatRoomWorkspaceExperience({ runtime: first.views['chat-room'] }).key,
    renderChatRoomWorkspaceExperience({ runtime: second.views['chat-room'] }).key
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
    sendDirective: async (directive) => {
      calls.push(`send:${typeof directive === 'string' ? directive : directive.text}`);
    },
    resolveApproval: (id: string, decision: 'approve' | 'reject') => calls.push(`approval:${id}:${decision}`),
    answerQuestion: (id: string, answer: string) => calls.push(`answer:${id}:${answer}`),
    pauseAll: () => calls.push('pauseAll'),
    sendExternalAgentInput: async (id: string, input: string) => {
      calls.push(`input:${id}:${input}`);
    },
    stopExternalAgent: async (id: string) => {
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
  expect(typeof runtime.actions.sendDirective).toBe('function');
  expect(typeof runtime.actions.resolveApproval).toBe('function');
  expect(typeof runtime.actions.switchExperience).toBe('function');
  expect('switchProject' in runtime.actions).toBe(false);

  runtime.actions.loadOlder();
  void runtime.actions.sendDirective('hello');
  runtime.actions.resolveApproval('approval-1', 'approve');
  runtime.actions.switchExperience('kanban');
  runtime.views['chat-room'].composer.answerQuestion('question-1', 'answer');

  expect(calls).toEqual([
    'loadOlder',
    'send:hello',
    'approval:approval-1:approve',
    'experience:kanban',
    'answer:question-1:answer'
  ]);
});
