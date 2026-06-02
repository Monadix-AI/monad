import type { Edge } from '@xyflow/react';

import { Background, BackgroundVariant, Controls, MarkerType, ReactFlow } from '@xyflow/react';
import { useMemo } from 'react';

import '@xyflow/react/dist/style.css';

import type { AgentFlowNodeId } from './agent-flow-model';

import { useT } from '#/components/I18nProvider';
import { AgentFlowNode, type AgentFlowReactNode } from './AgentFlowNode';
import { AGENT_FLOW_ICON_SRC } from './agent-flow-icons';
import { AGENT_FLOW_NODE_IDS } from './agent-flow-model';

const NODE_TYPES = { agentFlow: AgentFlowNode };

const FLOW_EDGES: Edge[] = AGENT_FLOW_NODE_IDS.slice(0, -1).map((source, index) => ({
  id: `${source}-${AGENT_FLOW_NODE_IDS[index + 1]}`,
  source,
  target: AGENT_FLOW_NODE_IDS[index + 1] as string,
  markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
  style: { stroke: 'var(--muted-foreground)', strokeOpacity: 0.42, strokeWidth: 1.4 }
}));

interface AgentFlowCanvasProps {
  onSelect: (id: AgentFlowNodeId) => void;
  selected: AgentFlowNodeId | null;
  summaries: Record<AgentFlowNodeId, string[]>;
}

export function AgentFlowCanvas({ onSelect, selected, summaries }: AgentFlowCanvasProps) {
  const t = useT();
  const nodes = useMemo<AgentFlowReactNode[]>(
    () =>
      AGENT_FLOW_NODE_IDS.map((id, index) => ({
        id,
        type: 'agentFlow',
        position: { x: 96, y: index * 145 },
        selected: selected === id,
        data: {
          iconSrc: AGENT_FLOW_ICON_SRC[id],
          id,
          onSelect,
          question: t(`web.studio.agentEditor.node.${id}.question`),
          step: index + 1,
          summary: summaries[id],
          title: t(`web.studio.agentEditor.node.${id}.title`)
        }
      })),
    [onSelect, selected, summaries, t]
  );

  return (
    <ReactFlow<AgentFlowReactNode>
      aria-label={t('web.studio.agentEditor.canvasAria')}
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
