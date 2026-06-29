import type { Edge, Node } from '@xyflow/react';
import type { ActivityStatus, Participant } from '../../types';
import type { ProjectCanvas } from '../types';

// Pure projection of the chatroom canvas → React Flow nodes/edges. Deterministic (circular layout,
// no random/layout engine) so it is unit-testable and stable across renders. A central "monad" hub
// with participants around it and the most recent activity steps as a column. Colors carry real
// state: participants by presence (working/online/idle), activity steps by status (ok/error/running).
type GraphInput = Pick<ProjectCanvas, 'participants' | 'activity'>;

export const HUB_ID = 'hub:monad';
const HUMAN_COLOR = '#0ea5e9';
const HUB_COLOR = '#444441';
const RECENT_ACTIVITY = 6;

// Agent node tint by live presence; human participants keep a fixed color.
const AGENT_PRESENCE_COLOR: Record<Participant['presence'], string> = {
  working: '#f59e0b',
  online: '#6366f1',
  idle: '#6b7280'
};
const ACTIVITY_STATUS_COLOR: Record<ActivityStatus, string> = {
  ok: '#10b981',
  error: '#ef4444',
  running: '#378add'
};

function participantColor(p: Participant): string {
  return p.kind === 'human' ? HUMAN_COLOR : AGENT_PRESENCE_COLOR[p.presence];
}

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
      style: nodeStyle(participantColor(p))
    });
    edges.push({ id: `e:p:${p.id}`, source: HUB_ID, target: id });
  });

  activity.slice(-RECENT_ACTIVITY).forEach((a, i) => {
    const id = `a:${a.id}`;
    nodes.push({
      id,
      position: { x: -radius - 160, y: (i - (RECENT_ACTIVITY - 1) / 2) * 64 },
      data: { label: a.tool },
      style: nodeStyle(ACTIVITY_STATUS_COLOR[a.status])
    });
    edges.push({ id: `e:a:${a.id}`, source: HUB_ID, target: id, animated: a.status === 'running' });
  });

  return { nodes, edges };
}
