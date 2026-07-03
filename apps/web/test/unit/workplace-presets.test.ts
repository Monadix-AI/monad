import type { ActivityRow, Participant } from '../../features/workplace/types.ts';
import type { ProjectController } from '../../features/workplace/use-project.ts';

import { expect, test } from 'bun:test';

import {
  getProjectExperience,
  listProjectExperiences,
  toProjectExperienceDefinitions
} from '../../features/workplace/experiences/registry.ts';
import { toExperienceRuntime } from '../../features/workplace/experiences/to-runtime.ts';
import { canvasToGraph, HUB_ID } from '../../features/workplace/presets/graph/graph-model.ts';
import { toCanvas } from '../../features/workplace/presets/to-canvas.ts';
import { projectMemberParticipants } from '../../features/workplace/use-project.ts';

const participant = (
  id: string,
  kind: Participant['kind'],
  presence: Participant['presence'] = 'online'
): Participant => ({ id, av: id.slice(0, 2).toUpperCase(), name: id, kind, tag: 'AI', presence }) as Participant;

const activityRow = (id: string, tool: string, status: ActivityRow['status']): ActivityRow =>
  ({ id, av: 'MO', tool, detail: tool, status }) as ActivityRow;

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

  expect(nodes.find((n) => n.id === HUB_ID)).toBeDefined();
  // hub + 2 participants + 2 activity
  expect(nodes).toHaveLength(5);
  // every participant + activity node is linked to the hub
  expect(edges).toHaveLength(4);
  expect(edges.every((e) => e.source === HUB_ID)).toBe(true);
  // a running step animates; a settled one does not
  expect(edges.find((e) => e.id === 'e:a:a2')?.animated).toBe(true);
  expect(edges.find((e) => e.id === 'e:a:a1')?.animated).toBe(false);
});

test('canvasToGraph: deterministic — same input yields identical node positions', () => {
  const input = { participants: [participant('monad', 'agent')], activity: [] };
  expect(canvasToGraph(input)).toEqual(canvasToGraph(input));
});

test('canvasToGraph: only the most recent activity steps are projected', () => {
  const activity = Array.from({ length: 10 }, (_, i) => activityRow(`a${i}`, `tool${i}`, 'ok'));
  const { nodes } = canvasToGraph({ participants: [], activity });
  // hub + 6 most-recent activity steps
  expect(nodes).toHaveLength(7);
  expect(nodes.some((n) => n.id === 'a:a9')).toBe(true);
  expect(nodes.some((n) => n.id === 'a:a0')).toBe(false);
});

test('toCanvas: exposes display data but drops every management/communication action', () => {
  const controller = {
    ready: true,
    projectTab: 'chat',
    messages: [],
    participants: [participant('monad', 'agent')],
    activity: [],
    nativeCliStreams: [],
    tasks: [],
    typing: null,
    firstItemIndex: 0,
    loadOlder: () => {},
    sendNativeCliInput: async () => {},
    stopNativeCli: async () => {},
    // management/communication actions that MUST NOT cross the seam
    sendDirective: async () => {},
    setWorkdir: async () => {},
    resolveApproval: () => {},
    approveAll: () => {},
    pauseAll: () => {},
    switchProject: () => {},
    preset: { id: 'chat', set: async () => {} }
  } as unknown as ProjectController;

  const canvas = toCanvas(controller);

  expect(canvas.ready).toBe(true);
  expect(canvas.participants).toHaveLength(1);
  expect(canvas.nativeCliStreams).toEqual([]);
  // the passthrough live-agent controls are present (host-provided, surfaced inline)
  expect(typeof canvas.sendNativeCliInput).toBe('function');
  expect(typeof canvas.stopNativeCli).toBe('function');
  // no management/communication action leaked onto the canvas
  for (const leaked of [
    'sendDirective',
    'setWorkdir',
    'resolveApproval',
    'approveAll',
    'pauseAll',
    'switchProject',
    'preset'
  ]) {
    expect(leaked in canvas).toBe(false);
  }
});

test('project member participant projection keeps invited agent members including monad', () => {
  expect(
    projectMemberParticipants([participant('monad', 'agent'), participant('codex', 'agent')]).map((p) => p.id)
  ).toEqual(['monad', 'codex']);
});

test('project experiences: built-ins expose full runtime-switchable project experiences', () => {
  const experiences = listProjectExperiences();

  expect(experiences.map((experience) => experience.id)).toEqual(['chat-room', 'graphic-view']);
  expect(experiences.every((experience) => experience.source === 'builtin')).toBe(true);
  expect(getProjectExperience('graphic-view').id).toBe('graphic-view');
  expect(getProjectExperience('missing').id).toBe('chat-room');
});

test('project experiences: workspace-experience atoms join the runtime-switchable registry', () => {
  const atoms = toProjectExperienceDefinitions([
    {
      id: 'custom-canvas',
      title: 'Custom Canvas',
      entry: { type: 'web-component', module: '/atoms/packs/custom/canvas.js', tagName: 'custom-canvas' }
    }
  ]);
  const experiences = listProjectExperiences(atoms);

  expect(experiences.map((experience) => experience.id)).toEqual(['chat-room', 'graphic-view', 'custom-canvas']);
  expect(getProjectExperience('custom-canvas', experiences)).toMatchObject({
    id: 'custom-canvas',
    label: 'Custom Canvas',
    source: 'atom'
  });
  expect(getProjectExperience('graph', experiences).id).toBe('graphic-view');
  expect(getProjectExperience('missing', experiences).id).toBe('chat-room');
});

test('toExperienceRuntime: exposes project data and controlled communication actions', () => {
  const calls: string[] = [];
  const controller = {
    ready: true,
    projectId: 'project-1',
    sessionId: 'sess-1',
    projects: [],
    participants: [participant('monad', 'agent')],
    railAgents: [participant('monad', 'agent')],
    projectMembers: [],
    availableProjectMembers: [],
    messages: [],
    firstItemIndex: 0,
    loadOlder: () => calls.push('loadOlder'),
    typing: null,
    activity: [],
    nativeCliStreams: [],
    tasks: [],
    contextUsage: undefined,
    modelProfiles: [],
    approvals: [],
    workdir: { path: undefined, set: async () => {} },
    paused: false,
    mentionTargets: [],
    sendDirective: async (text: string) => calls.push(`send:${text}`),
    resolveApproval: (id: string, decision: 'approve' | 'reject') => calls.push(`approval:${id}:${decision}`),
    approveAll: () => calls.push('approveAll'),
    pauseAll: () => calls.push('pauseAll'),
    switchProject: () => calls.push('switchProject'),
    addProjectMember: async () => {},
    removeProjectMember: async () => {},
    updateProjectMemberSettings: async () => {},
    sendNativeCliInput: async (id: string, input: string) => calls.push(`input:${id}:${input}`),
    stopNativeCli: async (id: string) => calls.push(`stop:${id}`)
  } as unknown as ProjectController;

  const runtime = toExperienceRuntime(controller, { switchExperience: (id) => calls.push(`experience:${id}`) });

  expect(runtime.snapshot.projectId).toBe('project-1');
  expect(runtime.snapshot.participants).toHaveLength(1);
  expect(typeof runtime.actions.sendDirective).toBe('function');
  expect(typeof runtime.actions.resolveApproval).toBe('function');
  expect(typeof runtime.actions.switchExperience).toBe('function');
  expect('switchProject' in runtime.actions).toBe(false);
  expect('moderator' in runtime.snapshot).toBe(false);

  runtime.actions.loadOlder();
  void runtime.actions.sendDirective('hello');
  runtime.actions.resolveApproval('approval-1', 'approve');
  runtime.actions.switchExperience('graphic-view');

  expect(calls).toEqual(['loadOlder', 'send:hello', 'approval:approval-1:approve', 'experience:graphic-view']);
});
