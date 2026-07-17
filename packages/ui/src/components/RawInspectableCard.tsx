import type { ReactNode } from 'react';

import { Copy01Icon, SourceCodeIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useId } from 'react';

import { cn } from '../lib/utils';
import { Button } from './Button';
import { CodeBlock } from './CodeBlock';
import { Tooltip, TooltipContent, TooltipTrigger } from './Tooltip';

export interface RawEventRecord {
  id: string;
  text: string;
  timestamp?: string;
}

export interface RawInspectableCardLabels {
  copy: string;
  hide: string;
  show: string;
}

export interface RawInspectableCardProps {
  children: ReactNode;
  className?: string;
  labels: RawInspectableCardLabels;
  onCopy?: (text: string) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  records: readonly RawEventRecord[];
}

export function rawEventRecordsText(records: readonly RawEventRecord[]): string {
  return records.map((record) => record.text).join('\n');
}

export function formattedRawEventRecordText(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text) as unknown, null, 2);
  } catch {
    return text;
  }
}

export function RawInspectableCard({
  children,
  className,
  labels,
  onCopy,
  onOpenChange,
  open,
  records
}: RawInspectableCardProps) {
  const panelId = useId();
  if (records.length === 0) return children;
  const text = rawEventRecordsText(records);
  const toggleLabel = open ? labels.hide : labels.show;

  return (
    <div
      className={cn(
        'group/raw-card relative text-card-foreground data-[open=true]:[&>[data-slot]:first-of-type]:rounded-b-none',
        className
      )}
      data-open={open}
      data-selectable="true"
      data-slot="raw-inspectable-card"
    >
      <div
        className="absolute top-2 right-2 z-10 flex items-center gap-1 opacity-0 transition-opacity group-focus-within/raw-card:opacity-100 group-hover/raw-card:opacity-100 data-[open=true]:opacity-100 [@media_(hover:none),_(pointer:coarse)]:opacity-100"
        data-open={open}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-controls={panelId}
              aria-expanded={open}
              aria-label={toggleLabel}
              onClick={(event) => {
                event.stopPropagation();
                onOpenChange(!open);
              }}
              size="icon-sm"
              title={toggleLabel}
              type="button"
              variant="ghost"
            >
              <HugeiconsIcon
                aria-hidden="true"
                icon={SourceCodeIcon}
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{toggleLabel}</TooltipContent>
        </Tooltip>
      </div>
      {children}
      {open ? (
        <section
          aria-label={labels.show}
          className="-mt-px rounded-b-lg border border-border bg-background/55 p-3"
          id={panelId}
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">JSONL</span>
            {onCopy ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    aria-label={labels.copy}
                    onClick={(event) => {
                      event.stopPropagation();
                      onCopy(text);
                    }}
                    size="icon-sm"
                    title={labels.copy}
                    type="button"
                    variant="ghost"
                  >
                    <HugeiconsIcon
                      aria-hidden="true"
                      icon={Copy01Icon}
                    />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{labels.copy}</TooltipContent>
              </Tooltip>
            ) : null}
          </div>
          <div className="grid max-h-64 gap-2 overflow-auto">
            {records.map((record) => (
              <CodeBlock
                className="border-0 bg-transparent [&_pre]:p-0 [&_pre]:text-[11px] [&_pre]:leading-relaxed"
                code={formattedRawEventRecordText(record.text)}
                key={record.id}
                language="json"
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
