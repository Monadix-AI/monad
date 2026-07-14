import type { Edge, NodeMouseHandler } from '@xyflow/react';

import {
  BrainIcon,
  MessageMultiple01Icon,
  PencilEdit01Icon,
  ShieldHalfIcon,
  UserGroupIcon,
  Wrench01Icon
} from '@hugeicons/core-free-icons';
import { Background, BackgroundVariant, Controls, MarkerType, ReactFlow } from '@xyflow/react';
import { useMemo } from 'react';

import '@xyflow/react/dist/style.css';

import type { AgentFlowNodeId } from './agent-flow-model';

import { AgentFlowNode, type AgentFlowReactNode } from './AgentFlowNode';

const NODE_TYPES = { agentFlow: AgentFlowNode };
const FLOW_IDS: AgentFlowNodeId[] = ['request', 'identity', 'model', 'tools', 'safety', 'response'];

const FLOW_COPY: Record<AgentFlowNodeId, { title: string; question: string }> = {
  request: { title: 'User request', question: 'What is the user asking?' },
  identity: { title: 'Agent identity & instructions', question: 'Who is this agent and how should it act?' },
  model: { title: 'Model', question: 'Which model should it use?' },
  tools: { title: 'Tools & knowledge', question: 'What can it access?' },
  safety: { title: 'Safety check', question: 'What should be checked or blocked?' },
  response: { title: 'Response', question: 'How should it respond?' }
};

const FLOW_ICONS = {
  request: UserGroupIcon,
  identity: PencilEdit01Icon,
  model: BrainIcon,
  tools: Wrench01Icon,
  safety: ShieldHalfIcon,
  response: MessageMultiple01Icon
};

const FLOW_EDGES: Edge[] = FLOW_IDS.slice(0, -1).map((source, index) => ({
  id: `${source}-${FLOW_IDS[index + 1]}`,
  source,
  target: FLOW_IDS[index + 1] as string,
  markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
  style: { stroke: 'var(--muted-foreground)', strokeOpacity: 0.42, strokeWidth: 1.4 }
}));

interface AgentFlowCanvasProps {
  onClearSelection: () => void;
  onSelect: (id: AgentFlowNodeId) => void;
  selected: AgentFlowNodeId | null;
  summaries: Record<Exclude<AgentFlowNodeId, 'request'>, string[]>;
}

export function AgentFlowCanvas({ onClearSelection, onSelect, selected, summaries }: AgentFlowCanvasProps) {
  const nodes = useMemo<AgentFlowReactNode[]>(
    () =>
      FLOW_IDS.map((id, index) => ({
        id,
        type: 'agentFlow',
        position: { x: 96, y: index * 145 },
        selected: selected === id,
        data: {
          icon: FLOW_ICONS[id],
          id,
          question: FLOW_COPY[id].question,
          step: index + 1,
          summary:
            id === 'request'
              ? ['Example: “Add error monitoring to the API”']
              : summaries[id as Exclude<AgentFlowNodeId, 'request'>],
          title: FLOW_COPY[id].title
        }
      })),
    [selected, summaries]
  );

  const handleNodeClick: NodeMouseHandler<AgentFlowReactNode> = (_event, node) => {
    onSelect(node.id as AgentFlowNodeId);
  };

  return (
    <ReactFlow<AgentFlowReactNode>
      aria-label="Agent configuration flow"
      defaultViewport={{ x: 64, y: 28, zoom: 0.82 }}
      edges={FLOW_EDGES}
      fitView
      fitViewOptions={{ padding: 0.08, maxZoom: 1 }}
      maxZoom={1.2}
      minZoom={0.52}
      nodes={nodes}
      nodesConnectable={false}
      nodesDraggable={false}
      nodeTypes={NODE_TYPES}
      onNodeClick={handleNodeClick}
      onPaneClick={onClearSelection}
      proOptions={{ hideAttribution: true }}
    >
      <Background
        color="var(--border)"
        gap={22}
        size={1}
        variant={BackgroundVariant.Dots}
      />
      <Controls
        position="bottom-left"
        showInteractive={false}
      />
    </ReactFlow>
  );
}
