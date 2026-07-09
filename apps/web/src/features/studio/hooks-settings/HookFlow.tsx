'use client';

import type { HookEvent } from '@monad/protocol';
import type { Edge, EdgeProps, Node, NodeProps } from '@xyflow/react';
import type { TFn } from '#/components/I18nProvider';

import { PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button } from '@monad/ui';
import {
  BaseEdge,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState
} from '@xyflow/react';
import { memo, useEffect, useMemo } from 'react';

import '@xyflow/react/dist/style.css';

type HookPhaseId = 'session' | 'turn' | 'modelTool' | 'context' | 'subagent' | 'close';
type HookFlowEvent = {
  event: HookEvent;
  title: string;
  description: string;
  count: number;
};
type HookNodeData = HookFlowEvent & {
  optional: boolean;
  phaseColor: string;
  onAdd: (event: HookEvent) => void;
};
type PhaseNodeData = {
  color: string;
  label: string;
};
type HookHandleId = 'top' | 'right' | 'bottom' | 'left';
type FlowNodeData = HookNodeData | PhaseNodeData;
type FlowNode = Node<FlowNodeData>;
type HookEdgeRoute = 'direct' | 'horizontal-first' | 'vertical-first';
type HookEdgeData = Record<string, unknown> & {
  dashed?: boolean;
  route?: HookEdgeRoute;
};
type HookEdge = Edge<HookEdgeData, 'orthogonal'>;

const PHASE_COLORS: Record<HookPhaseId, string> = {
  session: 'oklch(0.55 0.214 256.8)',
  turn: 'oklch(0.633 0.199 183.5)',
  modelTool: 'oklch(0.488 0.217 293.5)',
  context: 'oklch(0.768 0.158 70.1)',
  subagent: 'oklch(0.645 0.246 16.4)',
  close: 'oklch(0.205 0 0)'
};

const HOOK_PHASES: { id: HookPhaseId; events: HookEvent[] }[] = [
  { id: 'session', events: ['SessionStart'] },
  { id: 'turn', events: ['BeforeTurn'] },
  { id: 'modelTool', events: ['BeforeModel', 'BeforeTool', 'ApprovalRequest', 'AfterTool', 'AfterModel'] },
  { id: 'context', events: ['BeforeCompact', 'AfterCompact'] },
  { id: 'subagent', events: ['BeforeSubagent', 'AfterSubagent'] },
  { id: 'close', events: ['AfterTurn', 'SessionEnd'] }
];

const EVENT_PHASE = HOOK_PHASES.reduce(
  (acc, phase) => {
    for (const event of phase.events) acc[event] = phase.id;
    return acc;
  },
  {} as Record<HookEvent, HookPhaseId>
);

const FLOW_POSITIONS: Record<HookEvent, { x: number; y: number }> = {
  SessionStart: { x: 620, y: 20 },
  BeforeTurn: { x: 620, y: 170 },
  BeforeCompact: { x: 430, y: 330 },
  AfterCompact: { x: 770, y: 310 },
  BeforeSubagent: { x: 20, y: 600 },
  BeforeTool: { x: 520, y: 500 },
  BeforeModel: { x: 770, y: 500 },
  ApprovalRequest: { x: 280, y: 600 },
  AfterTool: { x: 520, y: 740 },
  AfterModel: { x: 770, y: 740 },
  AfterSubagent: { x: 20, y: 800 },
  AfterTurn: { x: 620, y: 950 },
  SessionEnd: { x: 620, y: 1120 }
};

const PHASE_AREAS: { id: HookPhaseId; label: string; x: number; y: number; width: number; height: number }[] = [
  { id: 'session', label: 'Session', x: -30, y: -20, width: 1130, height: 1300 },
  { id: 'turn', label: 'User turn', x: 0, y: 140, width: 1060, height: 1080 },
  { id: 'modelTool', label: 'Agent loop', x: 250, y: 300, width: 830, height: 670 },
  { id: 'subagent', label: 'Subagent', x: 0, y: 545, width: 260, height: 430 }
];

const OPTIONAL_EVENTS = new Set<HookEvent>([
  'BeforeTool',
  'ApprovalRequest',
  'AfterTool',
  'BeforeCompact',
  'AfterCompact',
  'BeforeSubagent',
  'AfterSubagent'
]);

const FLOW_EDGES: {
  dashed?: boolean;
  route?: HookEdgeRoute;
  source: HookEvent;
  sourceHandle: HookHandleId;
  target: HookEvent;
  targetHandle: HookHandleId;
}[] = [
  { source: 'SessionStart', sourceHandle: 'bottom', target: 'BeforeTurn', targetHandle: 'top' },
  {
    route: 'horizontal-first',
    source: 'BeforeTurn',
    sourceHandle: 'bottom',
    target: 'BeforeCompact',
    targetHandle: 'top'
  },
  { source: 'BeforeCompact', sourceHandle: 'right', target: 'AfterCompact', targetHandle: 'left' },
  {
    route: 'horizontal-first',
    source: 'AfterCompact',
    sourceHandle: 'bottom',
    target: 'BeforeModel',
    targetHandle: 'top'
  },
  { source: 'BeforeModel', sourceHandle: 'left', target: 'BeforeTool', targetHandle: 'right' },
  {
    route: 'horizontal-first',
    source: 'BeforeTool',
    sourceHandle: 'left',
    target: 'ApprovalRequest',
    targetHandle: 'top'
  },
  {
    route: 'vertical-first',
    source: 'ApprovalRequest',
    sourceHandle: 'bottom',
    target: 'AfterTool',
    targetHandle: 'left'
  },
  { source: 'AfterTool', sourceHandle: 'right', target: 'AfterModel', targetHandle: 'left' },
  {
    route: 'horizontal-first',
    source: 'AfterModel',
    sourceHandle: 'bottom',
    target: 'AfterTurn',
    targetHandle: 'top'
  },
  {
    dashed: true,
    source: 'ApprovalRequest',
    sourceHandle: 'left',
    target: 'BeforeSubagent',
    targetHandle: 'right'
  },
  { source: 'BeforeSubagent', sourceHandle: 'bottom', target: 'AfterSubagent', targetHandle: 'top' },
  {
    dashed: true,
    route: 'horizontal-first',
    source: 'AfterSubagent',
    sourceHandle: 'right',
    target: 'AfterTool',
    targetHandle: 'left'
  },
  { source: 'AfterTurn', sourceHandle: 'bottom', target: 'SessionEnd', targetHandle: 'top' }
];

function HookNode({ data }: NodeProps<Node<HookNodeData>>) {
  return (
    <div className={`h-32 w-52 rounded-lg border bg-background p-3 shadow-xs ${data.optional ? 'border-dashed' : ''}`}>
      <Handle
        className="opacity-0"
        id="target-top"
        position={Position.Top}
        type="target"
      />
      <Handle
        className="opacity-0"
        id="target-right"
        position={Position.Right}
        type="target"
      />
      <Handle
        className="opacity-0"
        id="target-left"
        position={Position.Left}
        type="target"
      />
      <div
        className="mb-2 h-1 rounded-full"
        style={{ background: data.phaseColor }}
      />
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-sm">{data.title}</div>
          <p className="mt-1 line-clamp-2 text-muted-foreground text-xs leading-5">{data.description}</p>
        </div>
        <Button
          aria-label={`Add ${data.title} hook`}
          className="nodrag nowheel size-7 shrink-0"
          onClick={() => data.onAdd(data.event)}
          size="icon"
          variant="outline"
        >
          <HugeiconsIcon
            className="size-3.5"
            icon={PlusSignIcon}
          />
        </Button>
      </div>
      <div className="mt-3 flex items-center justify-between text-xs">
        <span className="text-muted-foreground">hooks</span>
        <span className="rounded-full border px-2 py-0.5 font-medium">{data.count}</span>
      </div>
      <Handle
        className="opacity-0"
        id="source-bottom"
        position={Position.Bottom}
        type="source"
      />
      <Handle
        className="opacity-0"
        id="source-right"
        position={Position.Right}
        type="source"
      />
      <Handle
        className="opacity-0"
        id="source-left"
        position={Position.Left}
        type="source"
      />
    </div>
  );
}

const HookFlowNode = memo(HookNode);

function PhaseNode({ data }: NodeProps<Node<PhaseNodeData>>) {
  return (
    <div
      className="pointer-events-none h-full w-full rounded-xl border border-dashed px-4 py-3"
      style={{
        background: `color-mix(in oklch, ${data.color} 6%, transparent)`,
        borderColor: `color-mix(in oklch, ${data.color} 42%, transparent)`
      }}
    >
      <div className="font-medium text-foreground/50 text-sm">{data.label}</div>
    </div>
  );
}

const HookFlowPhaseNode = memo(PhaseNode);

function OrthogonalEdge({ data, id, markerEnd, sourceX, sourceY, style, targetX, targetY }: EdgeProps<HookEdge>) {
  const route =
    data?.route ?? (Math.abs(sourceX - targetX) < 1 || Math.abs(sourceY - targetY) < 1 ? 'direct' : 'horizontal-first');
  const path =
    route === 'direct'
      ? `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`
      : route === 'vertical-first'
        ? `M ${sourceX} ${sourceY} L ${sourceX} ${targetY} L ${targetX} ${targetY}`
        : `M ${sourceX} ${sourceY} L ${targetX} ${sourceY} L ${targetX} ${targetY}`;

  return (
    <BaseEdge
      id={id}
      markerEnd={markerEnd}
      path={path}
      style={style}
    />
  );
}

const HookFlowEdge = memo(OrthogonalEdge);

export function HookFlow({ events, onAdd }: { events: HookFlowEvent[]; onAdd: (event: HookEvent) => void; t: TFn }) {
  const edgeTypes = useMemo(() => ({ orthogonal: HookFlowEdge }), []);
  const nodeTypes = useMemo(() => ({ hook: HookFlowNode, phase: HookFlowPhaseNode }), []);
  const flow = useMemo(() => {
    const phaseNodes: FlowNode[] = PHASE_AREAS.map((area) => ({
      id: `phase-${area.id}`,
      type: 'phase',
      position: { x: area.x, y: area.y },
      data: { color: PHASE_COLORS[area.id], label: area.label },
      draggable: false,
      focusable: false,
      selectable: false,
      style: { height: area.height, width: area.width },
      zIndex: -1
    }));
    const hookNodes: FlowNode[] = events.map((item) => {
      const phase = EVENT_PHASE[item.event];
      return {
        id: item.event,
        type: 'hook',
        position: FLOW_POSITIONS[item.event],
        data: { ...item, optional: OPTIONAL_EVENTS.has(item.event), phaseColor: PHASE_COLORS[phase], onAdd },
        draggable: true,
        zIndex: 2
      };
    });
    const edges: HookEdge[] = FLOW_EDGES.map(({ dashed, route, source, sourceHandle, target, targetHandle }) => ({
      id: `${source}-${target}`,
      data: { dashed, route },
      source,
      sourceHandle: `source-${sourceHandle}`,
      target,
      targetHandle: `target-${targetHandle}`,
      markerEnd: { type: MarkerType.ArrowClosed },
      type: 'orthogonal',
      style: {
        stroke: 'oklch(0.52 0.01 34)',
        strokeDasharray: dashed ? '7 6' : undefined,
        strokeWidth: 1.8
      }
    }));
    return { edges, nodes: [...phaseNodes, ...hookNodes] };
  }, [events, onAdd]);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);

  useEffect(() => {
    setNodes((currentNodes) =>
      flow.nodes.map((node) => {
        const current = currentNodes.find((item) => item.id === node.id);
        if (node.type === 'phase') return node;
        if (!current) return node;
        return { ...node, position: current.position, selected: current.selected };
      })
    );
  }, [flow.nodes, setNodes]);

  return (
    <div className="min-h-0 flex-1 px-5 py-4">
      <ReactFlowProvider>
        <ReactFlow
          defaultViewport={{ x: 116, y: 30, zoom: 0.78 }}
          edges={flow.edges}
          edgeTypes={edgeTypes}
          maxZoom={1.25}
          minZoom={0.35}
          nodes={nodes}
          nodesDraggable
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          proOptions={{ hideAttribution: true }}
        >
          <Controls showInteractive={false} />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}
