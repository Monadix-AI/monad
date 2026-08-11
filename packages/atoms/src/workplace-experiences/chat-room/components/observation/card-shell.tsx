import type { IconSvgElement } from '@hugeicons/react';
import type { ObservationVisualRole, OrbState } from '@monad/ui';

import {
  ArrowDown01Icon,
  FileCodeIcon,
  LinkSquare01Icon,
  TerminalIcon,
  Wrench01Icon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { ObservationCard, ThinkingOrb } from '@monad/ui';
import { requestVirtualListRowMeasurement } from '@monad/ui/components/VirtualList';

import { useObservationDisclosure } from './disclosure.tsx';

export function ObservationCardShell({
  children,
  header,
  timestamp,
  visualRole
}: {
  children: React.ReactNode;
  header?: React.ReactNode;
  timestamp?: string;
  visualRole: ObservationVisualRole;
}): React.ReactElement {
  return (
    <ObservationCard
      header={header}
      timestamp={timestamp}
      visualRole={visualRole}
    >
      {children}
    </ObservationCard>
  );
}

type ObservationToolKind = 'command' | 'file' | 'mcp' | 'tool';
export type ObservationToolStatus = 'error' | 'running' | 'success';

export function ObservationToolStatusIndicator({
  status
}: {
  status?: ObservationToolStatus;
}): React.ReactElement | null {
  if (!status) return null;
  return (
    <span
      aria-hidden="true"
      className={
        status === 'error'
          ? 'size-1.5 shrink-0 rounded-full bg-destructive'
          : status === 'running'
            ? 'size-1.5 shrink-0 rounded-full bg-accent-blue motion-safe:animate-pulse'
            : 'size-1.5 shrink-0 rounded-full bg-success'
      }
      data-slot="observation-tool-status"
      data-status={status}
    />
  );
}

export function ObservationToolCardShell({
  children,
  defaultOpen = false,
  error = false,
  header,
  kind,
  runningOrbState = 'shaping',
  status,
  timestamp
}: {
  children: React.ReactNode;
  defaultOpen?: boolean;
  error?: boolean;
  header: React.ReactNode;
  kind: ObservationToolKind;
  runningOrbState?: OrbState;
  status?: ObservationToolStatus;
  timestamp?: string;
}): React.ReactElement {
  const resolvedStatus = error ? 'error' : status;
  const [open, setOpen] = useObservationDisclosure('card', defaultOpen);
  return (
    <details
      className="group/tool rounded-md open:bg-secondary/15"
      data-slot="observation-tool-card"
      data-tool-kind={kind}
      data-visual-role={resolvedStatus === 'error' ? 'error' : 'tool'}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
        requestVirtualListRowMeasurement(event.currentTarget);
      }}
      open={open}
    >
      <summary className="group/tool-trigger flex min-h-6 w-full min-w-0 cursor-pointer list-none items-center gap-2 rounded-md px-0 py-0 text-left font-sans text-muted-foreground text-sm leading-5 transition-colors hover:bg-secondary/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/35 [&::-webkit-details-marker]:hidden">
        {resolvedStatus === 'running' ? (
          <ThinkingOrb
            aria-hidden="true"
            className="shrink-0"
            data-orb-state={runningOrbState}
            data-slot="observation-tool-orb"
            size={20}
            state={runningOrbState}
            style={{ height: 16, width: 16 }}
          />
        ) : (
          <HugeiconsIcon
            aria-hidden="true"
            className="shrink-0 text-muted-foreground/80 transition-colors group-hover/tool-trigger:text-foreground"
            icon={observationToolIcon(kind)}
            size={16}
          />
        )}
        <div className="min-w-0 flex-[0_1_auto] [&_span]:transition-colors group-hover/tool-trigger:[&_span]:text-foreground">
          {header}
        </div>
        <ObservationToolStatusIndicator status={resolvedStatus === 'running' ? undefined : resolvedStatus} />
        <HugeiconsIcon
          aria-hidden="true"
          className="shrink-0 -rotate-90 transition-transform duration-150 group-open/tool:rotate-0"
          data-slot="disclosure-chevron"
          icon={ArrowDown01Icon}
          size={14}
        />
        {timestamp ? (
          <time className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground/70">{timestamp}</time>
        ) : null}
      </summary>
      <div className="ml-3 border-border/50 border-l py-2 pr-2 pl-5">{children}</div>
    </details>
  );
}

function observationToolIcon(kind: ObservationToolKind): IconSvgElement {
  if (kind === 'command') return TerminalIcon;
  if (kind === 'file') return FileCodeIcon;
  if (kind === 'mcp') return LinkSquare01Icon;
  return Wrench01Icon;
}

export function rawJsonText(raw: unknown): string {
  if (raw === undefined) return 'null';
  if (Array.isArray(raw)) return raw.map(rawRecordText).join('\n');
  return rawRecordText(raw);
}

export function toolCallSummary(text: string): string {
  const match = /^Tool call\s+([^\s]+)\s+(.+)$/s.exec(text.trim());
  if (!match) return text;
  const [, tool, rawInput] = match;
  if (!tool || rawInput === undefined) return text;
  try {
    const parsed = z.json().parse(JSON.parse(rawInput));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const command = (parsed as Record<string, unknown>).command;
      const description = (parsed as Record<string, unknown>).description;
      if (typeof command === 'string' && command.trim()) return `${tool}: ${command.trim()}`;
      if (typeof description === 'string' && description.trim()) return `${tool}: ${description.trim()}`;
    }
  } catch {
    return `${tool}: ${rawInput}`;
  }
  return `${tool}: ${rawInput}`;
}

function rawRecordText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

import { z } from 'zod';
