import type { ProjectExperienceView } from '../types';

import { Background, Controls, MiniMap, ReactFlow, ReactFlowProvider } from '@xyflow/react';
import { useMemo } from 'react';

import { Composer } from '../../Composer';
import { canvasToGraph } from './graph-model';

import '@xyflow/react/dist/style.css';

export function GraphicViewExperienceView({ runtime }: ProjectExperienceView): React.ReactElement {
  const { participants, activity } = runtime.graphicView.canvas;
  const { nodes, edges } = useMemo(() => canvasToGraph({ participants, activity }), [participants, activity]);
  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
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
      </div>
      <Composer room={runtime.composer} />
    </div>
  );
}
