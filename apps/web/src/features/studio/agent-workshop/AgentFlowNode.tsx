import type { Node, NodeProps } from '@xyflow/react';
import type { AgentFlowNodeId } from './agent-flow-model';

import { cn } from '@monad/ui';
import { Handle, Position } from '@xyflow/react';

type AgentFlowNodeData = {
  iconSrc: string;
  id: AgentFlowNodeId;
  onSelect: (id: AgentFlowNodeId) => void;
  question: string;
  step: number;
  summary: string[];
  title: string;
};

export type AgentFlowReactNode = Node<AgentFlowNodeData, 'agentFlow'>;

export function AgentFlowNode({ data, selected }: NodeProps<AgentFlowReactNode>) {
  return (
    <button
      aria-label={`${data.step}. ${data.title}. ${data.question}`}
      aria-selected={selected}
      className={cn(
        'nodrag nopan group w-[380px] rounded-2xl border bg-card px-4 py-3.5 text-left shadow-xs transition-[border-color,box-shadow,transform] focus-within:ring-2 focus-within:ring-ring/40',
        selected
          ? 'border-primary shadow-[0_10px_35px_-24px_theme(colors.primary)]'
          : 'border-border hover:border-foreground/25'
      )}
      onClick={(event) => {
        event.stopPropagation();
        data.onSelect(data.id);
      }}
      role="option"
      type="button"
    >
      <Handle
        className="!size-1 !border-0 !bg-muted-foreground/30 opacity-0"
        position={Position.Top}
        type="target"
      />
      <div className="flex items-start gap-3">
        <span className="grid size-12 shrink-0 place-items-center">
          {/* biome-ignore lint/performance/noImgElement: Workshop icons are local static assets in this Bun app. */}
          <img
            alt=""
            className={cn('size-12 object-contain transition-transform group-hover:scale-105', selected && 'scale-105')}
            draggable={false}
            src={data.iconSrc}
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="grid size-5 shrink-0 place-items-center rounded-full border text-[11px] text-muted-foreground">
              {data.step}
            </span>
            <span className="font-medium text-[15px] text-foreground">{data.title}</span>
          </span>
          <span className="mt-0.5 block text-muted-foreground text-xs">{data.question}</span>
          {data.summary.length > 0 ? (
            <span className="mt-3 flex flex-wrap gap-x-3 gap-y-1 border-t pt-2.5 text-[11px] text-muted-foreground">
              {data.summary.map((item) => (
                <span key={item}>{item}</span>
              ))}
            </span>
          ) : null}
        </span>
      </div>
      <Handle
        className="!size-1 !border-0 !bg-muted-foreground/30 opacity-0"
        position={Position.Bottom}
        type="source"
      />
    </button>
  );
}
