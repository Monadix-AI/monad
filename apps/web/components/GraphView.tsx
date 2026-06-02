'use client';

import type { GetGraphResponse } from '@monad/protocol';

import { useGetGraphQuery } from '@monad/client-rtk';
import { Button } from '@monad/ui';
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
import { Network } from 'lucide-react';
import { useMemo } from 'react';

import '@xyflow/react/dist/style.css';

import { useT } from '@/components/I18nProvider';
import { StudioPanel, StudioPanelHeader } from './studio/StudioPanel';

// A small, stable palette. Nodes are colored by SCOPE (which agent the entity belongs to) so a
// multi-agent graph stays legible — you can tell whose entity is whose at a glance — with a legend
// above. Unknown scopes fall back to a stable hash bucket. Type still shows in the node label.
const PALETTE = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#a855f7', '#ec4899', '#14b8a6'];
function colorFor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

// `agent:agt_abc…` → `agt_abc…`; `global` stays `global`. Keeps the legend short.
function scopeLabel(scope: string): string {
  return scope.startsWith('agent:') ? scope.slice('agent:'.length) : scope;
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
    const color = colorFor(byScope ? node.scope : (node.type ?? 'type'));
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

export function GraphView(_props: { onClose: () => void }) {
  const t = useT();
  const { data, isLoading, refetch, isFetching } = useGetGraphQuery();
  const { nodes, edges } = useMemo(() => toFlow(data), [data]);
  const scopes = useMemo(() => [...new Set(data?.nodes.map((node) => node.scope) ?? [])].sort(), [data]);
  const empty = !isLoading && nodes.length === 0;

  return (
    <StudioPanel>
      <StudioPanelHeader
        actions={
          <Button
            disabled={isFetching}
            onClick={() => refetch()}
            size="sm"
            variant="ghost"
          >
            {t('web.graph.refresh')}
          </Button>
        }
        icon={<Network className="size-4 text-muted-foreground" />}
        subtitle={data ? `${data.nodes.length} · ${data.edges.length}` : undefined}
        title={t('web.settings.graph')}
      />

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
                style={{ background: colorFor(s) }}
              />
              {scopeLabel(s)}
            </span>
          ))}
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        {empty ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 p-8 text-center text-muted-foreground text-sm">
            <Network className="size-8 opacity-40" />
            <p>{t('web.graph.empty')}</p>
            <p className="text-xs">{t('web.graph.emptyHint')}</p>
          </div>
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
    </StudioPanel>
  );
}
