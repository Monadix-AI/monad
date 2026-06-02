import type { PresetDefinition, ProjectView } from '../types';

import { Background, Controls, MiniMap, ReactFlow, ReactFlowProvider } from '@xyflow/react';
import { useMemo } from 'react';

import { canvasToGraph } from './graph-model';

import '@xyflow/react/dist/style.css';

// A flow-first projection of the same chatroom data: participants + recent activity as a graph
// around a monad hub. Read-only — input/management live in the host chrome and bottom composer.
function GraphPresetView({ canvas }: ProjectView): React.ReactElement {
  const { participants, activity } = canvas;
  const { nodes, edges } = useMemo(() => canvasToGraph({ participants, activity }), [participants, activity]);

  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0, background: 'var(--card)' }}>
      <ReactFlowProvider>
        <ReactFlow
          edges={edges}
          fitView
          nodes={nodes}
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
          />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}

export const graphPreset: PresetDefinition = {
  id: 'graph',
  labelKey: 'web.workplace.preset.graph',
  icon: 'git-fork',
  source: 'builtin',
  render: GraphPresetView
};
