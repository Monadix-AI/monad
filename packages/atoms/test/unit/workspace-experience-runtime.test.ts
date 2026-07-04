import type { ActivityRow, Participant } from '../../src/workspace-experiences/project/types.ts';
import type { ProjectExperienceRuntimeSource } from '../../src/workspace-experiences/runtime.ts';

import { expect, test } from 'bun:test';

import {
  requestSpawnAgentMemberDialog,
  spawnAgentMemberDialogRequest
} from '../../src/workspace-experiences/chat-room/components/view.tsx';
import { toChatRoomCanvas } from '../../src/workspace-experiences/chat-room/utils/canvas.ts';
import { canvasToGraph, HUB_ID } from '../../src/workspace-experiences/graph-view/utils/graph-model.ts';
import { createProjectExperienceRuntime } from '../../src/workspace-experiences/runtime.ts';

const participant = (
  id: string,
  kind: Participant['kind'],
  presence: Participant['presence'] = 'online'
): Participant => ({ id, av: id.slice(0, 2).toUpperCase(), name: id, kind, tag: 'AI', presence }) as Participant;

const activityRow = (id: string, tool: string, status: ActivityRow['status']): ActivityRow =>
  ({ id, av: 'MO', tool, detail: tool, status }) as ActivityRow;

function runtimeSource(overrides: Partial<ProjectExperienceRuntimeSource> = {}): ProjectExperienceRuntimeSource {
  const base: ProjectExperienceRuntimeSource = {
    activeProjectId: null,
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
      nativeCliSessions: [],
      human: participant('you', 'human'),
      nativeCliAvatarSeeds: new Map(),
      nativeCliTags: new Map(),
      nativeCliDisplayNames: new Map(),
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
    sendNativeCliInput: async () => {},
    stopNativeCli: async () => {}
  };
  return { ...base, ...overrides, source: { ...base.source, ...overrides.source } };
}

test('canvasToGraph: projects agent presence and activity status nodes', () => {
  const { nodes } = canvasToGraph({
    participants: [participant('busy', 'agent', 'working'), participant('idle', 'agent', 'idle')],
    activity: [activityRow('ok1', 'fs_read', 'ok'), activityRow('err1', 'shell', 'error')]
  });

  expect(nodes.some((node) => node.id === 'p:busy')).toBe(true);
  expect(nodes.some((node) => node.id === 'p:idle')).toBe(true);
  expect(nodes.some((node) => node.id === 'a:ok1')).toBe(true);
  expect(nodes.some((node) => node.id === 'a:err1')).toBe(true);
});

test('canvasToGraph: a monad hub, one node + edge per participant, recent activity attached', () => {
  const { nodes, edges } = canvasToGraph({
    participants: [participant('you', 'human'), participant('monad', 'agent')],
    activity: [activityRow('a1', 'fs_read', 'ok'), activityRow('a2', 'shell', 'running')]
  });

  expect(nodes.find((node) => node.id === HUB_ID)).toBeDefined();
  expect(nodes).toHaveLength(5);
  expect(edges).toHaveLength(4);
  expect(edges.every((edge) => edge.source === HUB_ID)).toBe(true);
  expect(edges.find((edge) => edge.id === 'e:a:a2')?.animated).toBe(true);
  expect(edges.find((edge) => edge.id === 'e:a:a1')?.animated).toBe(false);
});

test('canvasToGraph: deterministic same input yields identical node positions', () => {
  const input = { participants: [participant('monad', 'agent')], activity: [] };
  expect(canvasToGraph(input)).toEqual(canvasToGraph(input));
});

test('canvasToGraph: only the most recent activity steps are projected', () => {
  const activity = Array.from({ length: 10 }, (_, i) => activityRow(`a${i}`, `tool${i}`, 'ok'));
  const { nodes } = canvasToGraph({ participants: [], activity });

  expect(nodes).toHaveLength(7);
  expect(nodes.some((node) => node.id === 'a:a9')).toBe(true);
  expect(nodes.some((node) => node.id === 'a:a0')).toBe(false);
});

test('toChatRoomCanvas: exposes the chatroom surface without project management actions', () => {
  const canvas = toChatRoomCanvas(runtimeSource());

  expect(canvas.ready).toBe(true);
  expect(canvas.participants).toHaveLength(1);
  expect(canvas.railAgents).toHaveLength(1);
  expect(canvas.nativeCliStreams).toEqual([]);
  expect(typeof canvas.sendDirective).toBe('function');
  expect(typeof canvas.resolveApproval).toBe('function');
  expect(typeof canvas.answerQuestion).toBe('function');
  expect(typeof canvas.sendNativeCliInput).toBe('function');
  expect(typeof canvas.stopNativeCli).toBe('function');
  for (const leaked of ['setWorkdir', 'switchProject', 'experience']) {
    expect(leaked in canvas).toBe(false);
  }
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

test('createProjectExperienceRuntime: exposes project data and controlled communication actions', () => {
  const calls: string[] = [];
  const source = runtimeSource({
    loadOlder: () => calls.push('loadOlder'),
    sendDirective: async (text: string) => {
      calls.push(`send:${text}`);
    },
    resolveApproval: (id: string, decision: 'approve' | 'reject') => calls.push(`approval:${id}:${decision}`),
    answerQuestion: (id: string, answer: string) => calls.push(`answer:${id}:${answer}`),
    pauseAll: () => calls.push('pauseAll'),
    sendNativeCliInput: async (id: string, input: string) => {
      calls.push(`input:${id}:${input}`);
    },
    stopNativeCli: async (id: string) => {
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
  expect(runtime.views['graphic-view'].canvas.participants).toHaveLength(1);
  expect('messages' in runtime.views['graphic-view'].canvas).toBe(false);
  expect('composer' in runtime.views['graphic-view'].canvas).toBe(false);
  expect('chatRoom' in runtime.views['graphic-view'].canvas).toBe(false);
  expect('nativeCliStreams' in runtime.views['graphic-view'].canvas).toBe(false);
  expect('sendNativeCliInput' in runtime.views['graphic-view'].canvas).toBe(false);
  expect(typeof runtime.actions.sendDirective).toBe('function');
  expect(typeof runtime.actions.resolveApproval).toBe('function');
  expect(typeof runtime.actions.switchExperience).toBe('function');
  expect('switchProject' in runtime.actions).toBe(false);
  expect('moderator' in runtime.snapshot).toBe(false);

  runtime.actions.loadOlder();
  void runtime.actions.sendDirective('hello');
  runtime.actions.resolveApproval('approval-1', 'approve');
  runtime.actions.switchExperience('graphic-view');
  runtime.views['chat-room'].composer.answerQuestion('question-1', 'answer');

  expect(calls).toEqual([
    'loadOlder',
    'send:hello',
    'approval:approval-1:approve',
    'experience:graphic-view',
    'answer:question-1:answer'
  ]);
});
