'use client';

import type { GetGraphResponse } from '@monad/protocol';

import { NeuralNetworkIcon } from '@hugeicons/core-free-icons';
import { useGetGraphQuery } from '@monad/client-rtk';
import { Button, Skeleton } from '@monad/ui';
import {
  Background,
  Controls,
  type Edge,
  MarkerType,
  MiniMap,
  type Node,
  ReactFlow,
  ReactFlowProvider
} from '@xyflow/react';
import { useMemo } from 'react';

import '@xyflow/react/dist/style.css';

import { useT } from '@/components/I18nProvider';
import { DataEmpty } from './DataEmpty';
import { colorForScope, scopeLabel } from './scope';

function GraphSkeleton() {
  return (
    <div
      aria-busy="true"
      className="absolute inset-0 flex flex-col gap-3 p-6"
    >
      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-5 w-20 rounded-full" />
        <Skeleton className="h-5 w-24 rounded-full" />
        <Skeleton className="h-5 w-16 rounded-full" />
      </div>
      <div className="relative min-h-0 flex-1 rounded-lg border bg-muted/10">
        <Skeleton className="absolute top-[18%] left-[18%] h-10 w-28 rounded-lg" />
        <Skeleton className="absolute top-[32%] right-[20%] h-10 w-32 rounded-lg" />
        <Skeleton className="absolute bottom-[24%] left-[34%] h-10 w-28 rounded-lg" />
        <Skeleton className="absolute right-[30%] bottom-[16%] h-10 w-24 rounded-lg" />
        <span className="absolute top-[25%] left-[35%] h-px w-[28%] rotate-12 bg-border" />
        <span className="absolute right-[35%] bottom-[31%] h-px w-[24%] -rotate-12 bg-border" />
      </div>
    </div>
  );
}

// Deterministic circular layout — no native layout engine, fitView handles framing. Good enough for
// the modest graphs L2 builds; swap for dagre/elk if it grows.
function toFlow(data: GetGraphResponse | undefined): { nodes: Node[]; edges: Edge[] } {
  if (!data || data.nodes.length === 0) return { nodes: [], edges: [] };
  const n = data.nodes.length;
  const radius = Math.max(160, n * 30);
  // Color by scope only when there's more than one agent (so the legend tells them apart). With a
  // single scope that channel is wasted, so fall back to coloring by entity type.
  const byScope = new Set(data.nodes.map((node) => node.scope)).size > 1;
  const nodes: Node[] = data.nodes.map((node, i) => {
    const angle = (2 * Math.PI * i) / n;
    const color = colorForScope(byScope ? node.scope : (node.type ?? 'type'));
    return {
      id: node.id,
      position: { x: radius + radius * Math.cos(angle), y: radius + radius * Math.sin(angle) },
      data: { label: node.type ? `${node.name}\n(${node.type})` : node.name },
      style: {
        background: color,
        color: '#fff',
        border: 'none',
        borderRadius: 8,
        fontSize: 12,
        padding: 8,
        whiteSpace: 'pre-line',
        textAlign: 'center'
      }
    };
  });
  const edges: Edge[] = data.edges.map((e) => ({
    id: e.id,
    source: e.src,
    target: e.dst,
    label: e.relation,
    animated: e.provClass === 'user',
    markerEnd: { type: MarkerType.ArrowClosed },
    style: { strokeWidth: Math.max(1, e.confidence * 2.5) },
    labelStyle: { fontSize: 11 }
  }));
  return { nodes, edges };
}

// Read-only L2 knowledge-graph visualization. Rendered as a tab inside the Memory panel, so it
// supplies its own thin toolbar (count + refresh) rather than a full PanelShellHeader.
export function GraphView() {
  const t = useT();
  const { data, isLoading, refetch, isFetching } = useGetGraphQuery();
  const { nodes, edges } = useMemo(() => toFlow(data), [data]);
  const scopes = useMemo(() => [...new Set(data?.nodes.map((node) => node.scope) ?? [])].sort(), [data]);
  const empty = !isLoading && nodes.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b px-6 py-2">
        <span className="text-muted-foreground text-xs tabular-nums">
          {data ? `${data.nodes.length} · ${data.edges.length}` : ''}
        </span>
        <Button
          className="ml-auto"
          disabled={isFetching}
          onClick={() => refetch()}
          size="sm"
          variant="ghost"
        >
          {t('web.graph.refresh')}
        </Button>
      </div>

      {scopes.length > 1 ? (
        <div className="flex flex-wrap items-center gap-3 border-b px-6 py-2">
          <span className="text-muted-foreground text-xs">{t('web.graph.scopes')}</span>
          {scopes.map((s) => (
            <span
              className="flex items-center gap-1.5 text-muted-foreground text-xs"
              key={s}
            >
              <span
                className="inline-block size-2.5 rounded-full"
                style={{ background: colorForScope(s) }}
              />
              {scopeLabel(s)}
            </span>
          ))}
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        {isLoading ? (
          <GraphSkeleton />
        ) : empty ? (
          <DataEmpty
            hint={t('web.graph.emptyHint')}
            icon={NeuralNetworkIcon}
            title={t('web.graph.empty')}
          />
        ) : (
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
        )}
      </div>
    </div>
  );
}
