import type { ReactElement } from 'react';
import type { WorkspaceExperienceGraphCanvas } from '../utils/graph-model.ts';

import { cn } from '@monad/ui/lib/utils';
import { Background, Controls, MiniMap, ReactFlow, ReactFlowProvider } from '@xyflow/react';
import { createElement, useMemo } from 'react';

import { canvasToGraph } from '../utils/graph-model.ts';

import '@xyflow/react/dist/style.css';

export function GraphViewExperienceView({ canvas }: { canvas: WorkspaceExperienceGraphCanvas }): ReactElement {
  const { participants, activity } = canvas;
  const { nodes, edges } = useMemo(() => canvasToGraph({ participants, activity }), [participants, activity]);
  return createElement(
    'div',
    { className: cn('flex min-h-0 min-w-0 flex-1 flex-col') },
    createElement(
      'div',
      { className: cn('flex min-h-0 min-w-0 flex-1 flex-col') },
      createElement(
        'div',
        { className: cn('relative min-h-0 flex-1 bg-card') },
        createElement(
          ReactFlowProvider,
          null,
          createElement(
            ReactFlow,
            { edges, fitView: true, nodes, proOptions: { hideAttribution: true } },
            createElement(Background),
            createElement(Controls, { showInteractive: false }),
            createElement(MiniMap, { pannable: true, zoomable: true })
          )
        )
      )
    )
  );
}
