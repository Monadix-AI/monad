import type { ActivityRow, Participant } from '../../components/workplace/types.ts';
import type { ProjectController } from '../../components/workplace/use-project.ts';

import { expect, test } from 'bun:test';

import { canvasToGraph, HUB_ID } from '../../components/workplace/presets/graph/graph-model.ts';
import { toCanvas } from '../../components/workplace/presets/to-canvas.ts';

const participant = (
  id: string,
  kind: Participant['kind'],
  presence: Participant['presence'] = 'online'
): Participant => ({ id, av: id.slice(0, 2).toUpperCase(), name: id, kind, tag: 'AI', presence }) as Participant;

const activityRow = (id: string, tool: string, status: ActivityRow['status']): ActivityRow =>
  ({ id, av: 'MO', tool, detail: tool, status }) as ActivityRow;

test('canvasToGraph: nodes carry live state — agent presence + activity status as color', () => {
  const { nodes } = canvasToGraph({
    participants: [participant('busy', 'agent', 'working'), participant('idle', 'agent', 'idle')],
    activity: [activityRow('ok1', 'fs_read', 'ok'), activityRow('err1', 'shell', 'error')]
  });
  const byId = (id: string) => nodes.find((n) => n.id === id)?.style?.background;
  // a working agent tints differently from an idle one
  expect(byId('p:busy')).not.toBe(byId('p:idle'));
  // a failed step is not colored like a successful one
  expect(byId('a:ok1')).not.toBe(byId('a:err1'));
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
