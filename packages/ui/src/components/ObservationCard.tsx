import type { ReactNode } from 'react';

import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '../lib/utils';
import { MorphChevron } from './MorphChevron';

export type ObservationVisualRole = 'user' | 'agent' | 'tool' | 'system' | 'warning' | 'error';

const observationCardVariants = cva('w-full min-w-0 max-w-full rounded-lg border px-3 py-2.5', {
  variants: {
    visualRole: {
      agent: 'border-primary/30 bg-primary/[0.04]',
      error: 'border-destructive/45 bg-destructive/[0.06]',
      system: 'border-border bg-background',
      tool: 'border-warning/40 bg-warning/[0.04]',
      user: 'border-border bg-background',
      warning: 'border-warning/45 bg-warning/[0.06]'
    }
  },
  defaultVariants: {
    visualRole: 'system'
  }
});

export interface ObservationCardProps extends VariantProps<typeof observationCardVariants> {
  children: ReactNode;
  className?: string;
  collapsed: boolean;
  header?: ReactNode;
  onCollapsedChange: (collapsed: boolean) => void;
  timestamp?: string;
  visualRole: ObservationVisualRole;
}

export function ObservationCard({
  children,
  className,
  collapsed,
  header,
  onCollapsedChange,
  timestamp,
  visualRole
}: ObservationCardProps) {
  return (
    <article
      className={cn(observationCardVariants({ visualRole }), className)}
      data-slot="observation-card"
    >
      <button
        aria-expanded={!collapsed}
        className="flex min-h-6 w-full min-w-0 items-center gap-2 rounded-sm pr-8 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        onClick={() => onCollapsedChange(!collapsed)}
        type="button"
      >
        <MorphChevron
          className="size-3.5 shrink-0"
          expanded={!collapsed}
        />
        {header ? <div className="min-w-0 flex-1">{header}</div> : <span className="min-w-0 flex-1" />}
        {timestamp ? (
          <time
            className="shrink-0 font-mono text-[10px] text-muted-foreground"
            dateTime={timestamp}
          >
            {timestamp}
          </time>
        ) : null}
      </button>
      {collapsed ? null : <div className="pt-2.5">{children}</div>}
    </article>
  );
}

export interface ObservationMetaProps {
  children?: ReactNode;
  className?: string;
  compact?: boolean;
  label?: string;
  showSource?: boolean;
  source: string;
  title?: string;
  type?: string;
}

export function ObservationMeta({
  children,
  className,
  compact = false,
  label,
  showSource = false,
  source,
  title,
  type
}: ObservationMetaProps) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-1.5 font-mono text-[10px] uppercase leading-tight',
        !compact && 'mb-2',
        className
      )}
    >
      {label ? (
        <span
          className={cn(
            'rounded-full border border-border/75 px-1.5 py-0.5',
            label === 'tool' || label === 'result' || label === 'tool call'
              ? 'bg-warning/10 text-foreground'
              : 'bg-primary/10 text-foreground',
            label === 'system' && 'text-muted-foreground',
            label === 'error' && 'border-destructive/40 bg-destructive/10 text-destructive',
            label === 'warning' && 'border-warning/40 bg-warning/10 text-foreground'
          )}
        >
          {label}
        </span>
      ) : null}
      {title ? <span className="font-semibold text-foreground normal-case">{title}</span> : null}
      {showSource ? <span className="text-muted-foreground">{source}</span> : null}
      {type ? <span className="text-muted-foreground">{type}</span> : null}
      {children}
    </div>
  );
}

export interface ObservationTextProps {
  className?: string;
  compact?: boolean;
  contained?: boolean;
  observationRole: ObservationVisualRole;
  text: string;
}

export function ObservationText({
  className,
  compact = false,
  contained = false,
  observationRole,
  text
}: ObservationTextProps) {
  return (
    <div
      className={cn(
        'wrap-anywhere whitespace-pre-wrap break-words leading-relaxed',
        observationRole === 'system' ? 'text-muted-foreground' : 'text-foreground',
        observationRole === 'tool' ? 'font-mono text-[11px]' : 'text-[13px]',
        compact && 'text-xs',
        contained && 'max-h-64 overflow-auto rounded-md border border-border/70 bg-secondary/55 p-2',
        className
      )}
    >
      {inlineCodeParts(text)}
    </div>
  );
}

function inlineCodeParts(text: string): ReactNode {
  let offset = 0;
  return text.split(/(`[^`]+`)/g).map((part) => {
    const key = `${offset}:${part}`;
    offset += part.length;
    if (!(part.startsWith('`') && part.endsWith('`'))) return <span key={key}>{part}</span>;
    return (
      <code
        className="rounded-md border border-border/80 bg-secondary/75 px-1 py-px font-mono text-[0.94em]"
        key={key}
      >
        {part.slice(1, -1)}
      </code>
    );
  });
}

export interface DefaultObservationToolPairProps {
  callText: string;
  callTool?: string;
  provider: string;
  resultText: string;
  resultTool?: string;
}

export function DefaultObservationToolPair({
  callText,
  callTool,
  provider,
  resultText,
  resultTool
}: DefaultObservationToolPairProps) {
  return (
    <>
      <ObservationMeta
        label="tool"
        source={provider}
        type={callTool}
      />
      <ObservationText
        compact
        observationRole="tool"
        text={callText}
      />
      <div className="mt-2 border-border/80 border-t pt-2">
        <ObservationMeta
          label="result"
          source={provider}
          type={resultTool}
        />
        <ObservationText
          contained
          observationRole="tool"
          text={resultText}
        />
      </div>
    </>
  );
}

export { observationCardVariants };
