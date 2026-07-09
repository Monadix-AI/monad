'use client';

import type { UIItem } from '@monad/protocol';
import type { NodeProps } from '@xyflow/react';

import {
  Alert01Icon,
  BrainIcon,
  CheckmarkCircle02Icon,
  CircleIcon,
  Clock3Icon,
  ComputerTerminal01Icon,
  CpuIcon,
  GitBranchIcon,
  HelpCircleIcon,
  MessageSquareCodeIcon,
  PackageOpenIcon,
  ShieldQuestionMarkIcon,
  SparklesIcon,
  Target01Icon,
  TextIcon,
  Wrench01Icon,
  ZapIcon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { cn } from '@monad/ui';
import { Background, Controls, Handle, Position, ReactFlow, ReactFlowProvider } from '@xyflow/react';
import { memo, useEffect, useMemo, useState } from 'react';

import '@xyflow/react/dist/style.css';

import { type TFn, useT } from '#/components/I18nProvider';
import { ApprovalDisplayCard } from '#/features/session/ApprovalDisplayCard';
import {
  buildInspectorFlow,
  type InspectorNode,
  type InspectorNodeData,
  type InspectorStatus,
  type InspectorTimelineEntry,
  type InspectorTone
} from './agent-loop-inspector-model';

type InspectorViewMode = 'all' | 'live' | 'tools';

const TONE_CLASS: Record<InspectorTone, string> = {
  approval: 'border-amber-500/45 bg-amber-500/10',
  clarification: 'border-orange-500/45 bg-orange-500/10',
  compact: 'border-yellow-500/45 bg-yellow-500/10',
  context: 'border-sky-500/40 bg-sky-500/10',
  custom: 'border-teal-500/45 bg-teal-500/10',
  mcp: 'border-cyan-500/45 bg-cyan-500/10',
  model: 'border-emerald-500/40 bg-emerald-500/10',
  output: 'border-zinc-500/30 bg-background',
  skill: 'border-rose-500/40 bg-rose-500/10',
  subagent: 'border-purple-500/40 bg-purple-500/10',
  system: 'border-muted-foreground/30 bg-muted/50',
  thinking: 'border-indigo-500/40 bg-indigo-500/10',
  tool: 'border-info/40 bg-info/10',
  turn: 'border-primary/45 bg-primary/10'
};

const STATUS_CLASS: Record<InspectorStatus, string> = {
  active: 'text-primary',
  blocked: 'text-warning',
  done: 'text-success',
  error: 'text-destructive',
  pending: 'text-muted-foreground'
};

function nodeIcon(tone: InspectorTone) {
  switch (tone) {
    case 'approval':
      return ShieldQuestionMarkIcon;
    case 'clarification':
      return HelpCircleIcon;
    case 'compact':
      return PackageOpenIcon;
    case 'context':
      return TextIcon;
    case 'custom':
      return SparklesIcon;
    case 'mcp':
      return ZapIcon;
    case 'model':
      return CpuIcon;
    case 'output':
      return MessageSquareCodeIcon;
    case 'skill':
      return PackageOpenIcon;
    case 'subagent':
      return GitBranchIcon;
    case 'system':
      return ComputerTerminal01Icon;
    case 'thinking':
      return BrainIcon;
    case 'tool':
      return Wrench01Icon;
    default:
      return CircleIcon;
  }
}

function statusIcon(status: InspectorStatus) {
  switch (status) {
    case 'active':
      return Clock3Icon;
    case 'blocked':
      return Alert01Icon;
    case 'done':
      return CheckmarkCircle02Icon;
    case 'error':
      return Alert01Icon;
    default:
      return CircleIcon;
  }
}

function statusDot(status: InspectorStatus): string {
  return cn(
    'size-2 rounded-full',
    status === 'active' && 'bg-primary',
    status === 'blocked' && 'bg-amber-500',
    status === 'done' && 'bg-emerald-500',
    status === 'error' && 'bg-destructive',
    status === 'pending' && 'bg-muted-foreground/45'
  );
}

function toneLabel(tone: InspectorTone): string {
  return tone.replace(/_/g, ' ');
}

function safeJson(value: unknown): string {
  if (value === undefined) return 'No raw item for derived node.';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function InspectorNodeView({ data }: NodeProps<InspectorNode>) {
  const Icon = nodeIcon(data.tone);
  const StatusIcon = statusIcon(data.status);
  return (
    <div
      className={cn(
        'w-52 rounded-lg border px-3 py-3 text-left text-sm shadow-none transition-colors',
        TONE_CLASS[data.tone],
        data.status === 'active' && 'ring-2 ring-primary/35',
        data.status === 'error' && 'border-destructive/50 bg-destructive/10',
        data.status === 'blocked' && 'border-amber-500/60 bg-amber-500/15'
      )}
    >
      <Handle
        className="opacity-0"
        id="target-left"
        position={Position.Left}
        type="target"
      />
      <Handle
        className="opacity-0"
        id="target-top"
        position={Position.Top}
        type="target"
      />
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border border-current/15 bg-background/65">
          <HugeiconsIcon
            className="size-4"
            icon={Icon}
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-foreground">{data.title}</div>
          {data.detail ? <div className="mt-1 line-clamp-2 text-muted-foreground text-xs">{data.detail}</div> : null}
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2 text-xs">
        <span className={cn('inline-flex items-center gap-1.5', STATUS_CLASS[data.status])}>
          <HugeiconsIcon
            className={cn('size-3.5', data.status === 'active' && 'animate-pulse')}
            icon={StatusIcon}
          />
          {data.status}
        </span>
        {data.meta ? <span className="truncate font-mono text-muted-foreground">{data.meta}</span> : null}
      </div>
      <Handle
        className="opacity-0"
        id="source-right"
        position={Position.Right}
        type="source"
      />
      <Handle
        className="opacity-0"
        id="source-bottom"
        position={Position.Bottom}
        type="source"
      />
    </div>
  );
}

const InspectorNodeComponent = memo(InspectorNodeView);
const NODE_TYPES = { inspector: InspectorNodeComponent };

function isRuntimeToolTone(tone: InspectorTone): boolean {
  return tone === 'tool' || tone === 'skill' || tone === 'mcp' || tone === 'subagent' || tone === 'approval';
}

function shouldShowNode(node: InspectorNode, mode: InspectorViewMode): boolean {
  if (mode === 'all') return true;
  if (mode === 'tools') return node.data.tone === 'model' || isRuntimeToolTone(node.data.tone);
  return node.data.status === 'active' || node.data.status === 'blocked' || node.data.status === 'error';
}

function modeLabel(mode: InspectorViewMode, t: TFn): string {
  switch (mode) {
    case 'live':
      return t('web.inspector.modeLive');
    case 'tools':
      return t('web.inspector.modeTools');
    default:
      return t('web.inspector.modeAll');
  }
}

function InspectorControls({
  followCurrent,
  mode,
  onFollowChange,
  onModeChange,
  t
}: {
  followCurrent: boolean;
  mode: InspectorViewMode;
  onFollowChange: (value: boolean) => void;
  onModeChange: (value: InspectorViewMode) => void;
  t: TFn;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-border/70 border-b px-4 py-2.5">
      <div className="inline-flex rounded-md border bg-muted/35 p-0.5">
        {(['all', 'live', 'tools'] as const).map((value) => (
          <button
            className={cn(
              'h-7 rounded-sm px-2.5 font-medium text-xs transition-colors',
              mode === value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            )}
            key={value}
            onClick={() => onModeChange(value)}
            type="button"
          >
            {modeLabel(value, t)}
          </button>
        ))}
      </div>
      <button
        aria-pressed={followCurrent}
        className={cn(
          'inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 font-medium text-xs transition-colors',
          followCurrent ? 'border-primary/35 bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'
        )}
        onClick={() => onFollowChange(!followCurrent)}
        type="button"
      >
        <HugeiconsIcon
          className="size-3.5"
          icon={Target01Icon}
        />
        {t('web.inspector.followCurrent')}
      </button>
    </div>
  );
}

function CurrentStep({ current, t }: { current: InspectorNode | null; t: TFn }) {
  if (!current) return null;
  const Icon = statusIcon(current.data.status);
  return (
    <div className="flex items-center gap-2 border-border/70 border-b px-4 py-2.5 text-xs">
      <span className={cn('inline-flex items-center gap-1.5', STATUS_CLASS[current.data.status])}>
        <HugeiconsIcon
          className={cn('size-3.5', current.data.status === 'active' && 'animate-pulse')}
          icon={Icon}
        />
        {t('web.inspector.current')}
      </span>
      <span className="min-w-0 truncate font-medium">{current.data.title}</span>
      <span className="shrink-0 text-muted-foreground">{current.data.seq ?? toneLabel(current.data.tone)}</span>
    </div>
  );
}

function Timeline({
  entries,
  onSelect,
  selectedId,
  t
}: {
  entries: InspectorTimelineEntry[];
  onSelect: (id: string) => void;
  selectedId: string | null;
  t: TFn;
}) {
  if (entries.length === 0) return null;
  return (
    <div className="border-border/70 border-t px-4 py-3">
      <div className="mb-2 flex items-center justify-between text-xs">
        <span className="font-medium text-foreground">{t('web.inspector.timeline')}</span>
        <span className="text-muted-foreground">{t('web.inspector.events', { count: entries.length })}</span>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {entries.map((entry) => (
          <button
            className={cn(
              'flex min-w-36 items-center gap-2 rounded-md border px-2.5 py-2 text-left text-xs transition-colors',
              selectedId === entry.id ? 'border-primary/45 bg-primary/10' : 'border-border/70 bg-muted/30'
            )}
            key={entry.id}
            onClick={() => onSelect(entry.id)}
            type="button"
          >
            <span className={statusDot(entry.status)} />
            <span className="min-w-0">
              <span className="block truncate font-medium">{entry.title}</span>
              <span className="block truncate text-muted-foreground">{entry.seq ?? toneLabel(entry.tone)}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function InspectorDetails({ data, t }: { data: InspectorNodeData | null; t: TFn }) {
  if (!data) {
    return (
      <div className="flex min-h-40 flex-col justify-center gap-2 border-border/70 border-t px-4 py-4 text-sm">
        <p className="font-medium">{t('web.inspector.selectNode')}</p>
        <p className="text-muted-foreground text-xs">{t('web.inspector.selectNodeHint')}</p>
      </div>
    );
  }
  return (
    <div className="grid max-h-72 grid-rows-[auto_minmax(0,1fr)] border-border/70 border-t">
      <div className="flex items-start justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={statusDot(data.status)} />
            <h3 className="truncate font-semibold text-sm">{data.title}</h3>
          </div>
          <p className="mt-1 text-muted-foreground text-xs">
            {toneLabel(data.tone)} · {data.eventKind ?? 'derived'} · {data.seq ?? 'no seq'}
          </p>
        </div>
        {data.meta ? (
          <span className="shrink-0 rounded-full border px-2 py-1 font-mono text-muted-foreground text-xs">
            {data.meta}
          </span>
        ) : null}
      </div>
      <div className="min-h-0 overflow-auto border-border/70 border-t px-4 py-3">
        {data.item?.kind === 'approval' ? (
          <div className="mb-3">
            <ApprovalDisplayCard display={data.item.display} />
          </div>
        ) : null}
        {data.detail ? <p className="mb-3 text-muted-foreground text-xs">{data.detail}</p> : null}
        <pre className="whitespace-pre-wrap break-words rounded-md bg-muted/45 p-3 font-mono text-[11px] leading-relaxed">
          {safeJson(data.item)}
        </pre>
      </div>
    </div>
  );
}

export function AgentLoopInspector({ items }: { items: UIItem[] }) {
  const t = useT();
  const { currentNodeId, edges, nodes, summary, timeline } = useMemo(() => buildInspectorFlow(items, t), [items, t]);
  const [followCurrent, setFollowCurrent] = useState(true);
  const [mode, setMode] = useState<InspectorViewMode>('all');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const visibleNodeIds = useMemo(() => {
    const ids = new Set(nodes.filter((node) => shouldShowNode(node, mode)).map((node) => node.id));
    if (currentNodeId) ids.add(currentNodeId);
    return ids;
  }, [currentNodeId, nodes, mode]);
  const visibleNodes = useMemo(
    () =>
      nodes
        .filter((node) => visibleNodeIds.has(node.id))
        .map((node) => ({ ...node, selected: node.id === selectedNodeId })),
    [nodes, selectedNodeId, visibleNodeIds]
  );
  const visibleEdges = useMemo(
    () => edges.filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target)),
    [edges, visibleNodeIds]
  );
  const visibleTimeline = useMemo(
    () => timeline.filter((entry) => visibleNodeIds.has(entry.id)),
    [timeline, visibleNodeIds]
  );
  const currentNode = nodes.find((node) => node.id === currentNodeId) ?? null;
  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;
  const empty = items.length === 0;

  useEffect(() => {
    if (!followCurrent || !currentNodeId) return;
    setSelectedNodeId(currentNodeId);
  }, [currentNodeId, followCurrent]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-4 pt-3 pb-1 text-xs">
        <span className="rounded-full border px-2 py-1 text-muted-foreground">{summary.done} done</span>
        {summary.active + summary.blocked > 0 ? (
          <span className="rounded-full border border-primary/35 bg-primary/10 px-2 py-1 text-primary">
            {summary.active + summary.blocked} live
          </span>
        ) : null}
      </div>
      {!empty ? (
        <>
          <InspectorControls
            followCurrent={followCurrent}
            mode={mode}
            onFollowChange={setFollowCurrent}
            onModeChange={setMode}
            t={t}
          />
          <CurrentStep
            current={currentNode}
            t={t}
          />
        </>
      ) : null}
      <div className="relative h-[clamp(220px,34vh,380px)] shrink-0">
        {empty ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center text-muted-foreground text-sm">
            <HugeiconsIcon
              className="size-8 opacity-45"
              icon={CpuIcon}
            />
            <p className="font-medium text-foreground">{t('web.inspector.empty')}</p>
            <p className="max-w-72 text-xs">{t('web.inspector.emptyHint')}</p>
          </div>
        ) : (
          <ReactFlowProvider>
            <ReactFlow
              defaultEdgeOptions={{ type: 'smoothstep' }}
              edges={visibleEdges}
              fitView
              fitViewOptions={{ padding: 0.18 }}
              nodes={visibleNodes}
              nodesDraggable={false}
              nodeTypes={NODE_TYPES}
              onNodeClick={(_, node) => {
                setFollowCurrent(false);
                setSelectedNodeId(node.id);
              }}
              onPaneClick={() => setSelectedNodeId(null)}
              proOptions={{ hideAttribution: true }}
            >
              <Background
                gap={24}
                size={1}
              />
              <Controls showInteractive={false} />
            </ReactFlow>
          </ReactFlowProvider>
        )}
      </div>
      {!empty ? (
        <>
          <Timeline
            entries={visibleTimeline}
            onSelect={(id) => {
              setFollowCurrent(false);
              setSelectedNodeId(id);
            }}
            selectedId={selectedNodeId}
            t={t}
          />
          <InspectorDetails
            data={selectedNode?.data ?? null}
            t={t}
          />
        </>
      ) : null}
    </div>
  );
}
