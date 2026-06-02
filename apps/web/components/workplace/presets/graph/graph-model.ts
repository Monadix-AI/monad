import type { Edge, Node } from '@xyflow/react';
import type { ProjectCanvas } from '../types';

// Pure projection of the chatroom canvas → React Flow nodes/edges. Deterministic (circular layout,
// no random/layout engine) so it is unit-testable and stable across renders. A central "monad" hub
// with participants around it and the most recent activity steps as a column; running steps animate.
type GraphInput = Pick<ProjectCanvas, 'participants' | 'activity'>;

export const HUB_ID = 'hub:monad';
const AGENT_COLOR = '#6366f1';
const HUMAN_COLOR = '#0ea5e9';
const STEP_COLOR = '#10b981';
const HUB_COLOR = '#444441';
const RECENT_ACTIVITY = 6;

function nodeStyle(background: string): Node['style'] {
  return {
    background,
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    fontSize: 12,
    padding: 8,
    textAlign: 'center'
  };
}

export function canvasToGraph({ participants, activity }: GraphInput): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [
    { id: HUB_ID, position: { x: 0, y: 0 }, data: { label: 'monad' }, style: nodeStyle(HUB_COLOR) }
  ];
  const edges: Edge[] = [];

  const radius = Math.max(180, participants.length * 36);
  participants.forEach((p, i) => {
    const angle = (2 * Math.PI * i) / Math.max(1, participants.length);
    const id = `p:${p.id}`;
    nodes.push({
      id,
      position: { x: radius * Math.cos(angle), y: radius * Math.sin(angle) },
      data: { label: p.name },
      style: nodeStyle(p.kind === 'human' ? HUMAN_COLOR : AGENT_COLOR)
    });
    edges.push({ id: `e:p:${p.id}`, source: HUB_ID, target: id });
  });

  activity.slice(-RECENT_ACTIVITY).forEach((a, i) => {
    const id = `a:${a.id}`;
    nodes.push({
      id,
      position: { x: -radius - 160, y: (i - (RECENT_ACTIVITY - 1) / 2) * 64 },
      data: { label: a.tool },
      style: nodeStyle(STEP_COLOR)
    });
    edges.push({ id: `e:a:${a.id}`, source: HUB_ID, target: id, animated: a.status === 'running' });
  });

  return { nodes, edges };
}
