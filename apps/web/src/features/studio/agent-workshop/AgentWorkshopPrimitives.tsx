import type { SandboxMode } from '@monad/protocol';
import type { DragEvent, ReactNode } from 'react';

import { GripVerticalIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { Badge, cn } from '@monad/ui';

export const SANDBOX_MODES: SandboxMode[] = ['workspace', 'home', 'unrestricted', 'ephemeral'];
export const INHERIT = '__inherit__';
export const MODEL_ROLES = [
  { key: 'memory', label: 'Memory', hint: 'Extracts & consolidates long-term memory (cheap is ideal)' },
  { key: 'vision', label: 'Vision', hint: 'Multimodal chat model for image input' },
  { key: 'image', label: 'Image', hint: 'Image generation' },
  { key: 'speech', label: 'Speech', hint: 'Text-to-speech' },
  { key: 'embedding', label: 'Embedding', hint: 'Semantic search vectors' }
] as const;

export type WorkshopPart = 'brain' | 'prompt' | 'tools' | 'safety' | 'visibility';
export type DragPayload =
  | { type: 'part'; part: WorkshopPart }
  | { type: 'capability'; name: string; sourceKind: 'atom' | 'mcp' };
export interface CapabilityItem {
  detail: string;
  name: string;
  sourceKind: 'atom' | 'mcp';
}

export function serializePayload(payload: DragPayload): string {
  return JSON.stringify(payload);
}

export function parsePayload(event: DragEvent<HTMLElement>): DragPayload | null {
  const raw = event.dataTransfer.getData('application/json');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DragPayload;
    if (parsed && typeof parsed === 'object' && 'type' in parsed) return parsed;
  } catch {}
  return null;
}

interface PartCardProps {
  body: string;
  icon: IconSvgElement;
  onDragEnd: () => void;
  onSelect: () => void;
  onStartDrag: () => void;
  part: WorkshopPart;
  selected: boolean;
  title: string;
}

export function PartCard({ body, icon: Icon, onDragEnd, onSelect, onStartDrag, part, selected, title }: PartCardProps) {
  return (
    <button
      className={cn(
        'group flex w-full items-start gap-3 rounded-2xl border border-border/70 bg-card px-4 py-3 text-left transition hover:border-primary/40 hover:bg-primary/5 active:scale-[0.99]',
        selected && 'border-primary/60 bg-primary/5 shadow-[0_0_0_1px_var(--color-primary)]'
      )}
      data-testid={`workshop-part-${part}`}
      draggable
      onClick={onSelect}
      onDragEnd={onDragEnd}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('application/json', serializePayload({ type: 'part', part }));
        onStartDrag();
      }}
      type="button"
    >
      <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-secondary text-secondary-foreground">
        <HugeiconsIcon
          className="size-4"
          icon={Icon}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 font-medium text-sm">
          {title}
          <HugeiconsIcon
            className="size-3.5 text-muted-foreground"
            icon={GripVerticalIcon}
          />
        </span>
        <span className="mt-1 block text-muted-foreground text-xs leading-relaxed">{body}</span>
      </span>
    </button>
  );
}

interface WorkshopSlotProps {
  active: boolean;
  body: ReactNode;
  dragging: boolean;
  icon: IconSvgElement;
  onDrop: (part: WorkshopPart, event: DragEvent<HTMLButtonElement | HTMLDivElement>) => void;
  onSelect: () => void;
  part: WorkshopPart;
  summary: string;
  title: string;
}

export function WorkshopSlot({
  active,
  body,
  dragging,
  icon: Icon,
  onDrop,
  onSelect,
  part,
  summary,
  title
}: WorkshopSlotProps) {
  return (
    <button
      className={cn(
        'flex min-h-40 flex-col rounded-2xl border border-dashed bg-card p-5 text-left transition hover:border-primary/40 hover:bg-primary/5 active:scale-[0.99]',
        active && 'border-primary/70 bg-primary/5 shadow-[0_0_0_1px_var(--color-primary)]',
        dragging && 'border-primary/70 bg-primary/10'
      )}
      data-testid={`workshop-slot-${part}`}
      onClick={onSelect}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => onDrop(part, event)}
      type="button"
    >
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-xl bg-secondary text-secondary-foreground">
          <HugeiconsIcon
            className="size-4"
            icon={Icon}
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm">{title}</span>
            <Badge variant={active ? 'secondary' : 'outline'}>{summary}</Badge>
          </div>
        </div>
      </div>
      <div className="mt-4 text-sm">{body}</div>
    </button>
  );
}
