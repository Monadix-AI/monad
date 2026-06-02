import type { IconSvgElement } from '@hugeicons/react';
import type { ObservationVisualRole } from '@monad/ui';

import {
  ArrowDown01Icon,
  FileCodeIcon,
  LinkSquare01Icon,
  TerminalIcon,
  Wrench01Icon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { ObservationCard } from '@monad/ui';

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

export function ObservationToolCardShell({
  children,
  error = false,
  header,
  kind,
  timestamp
}: {
  children: React.ReactNode;
  error?: boolean;
  header: React.ReactNode;
  kind: ObservationToolKind;
  timestamp?: string;
}): React.ReactElement {
  return (
    <details
      className="group/tool rounded-md open:bg-secondary/15"
      data-slot="observation-tool-card"
      data-visual-role={error ? 'error' : 'tool'}
    >
      <summary className="flex min-h-8 w-full min-w-0 cursor-pointer list-none items-center gap-2 rounded-md px-1.5 py-1 text-left text-muted-foreground transition-colors hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/35 [&::-webkit-details-marker]:hidden">
        <HugeiconsIcon
          aria-hidden="true"
          className={error ? 'shrink-0 text-destructive' : 'shrink-0 text-muted-foreground/80'}
          icon={observationToolIcon(kind)}
          size={16}
        />
        <div className="min-w-0 flex-1">{header}</div>
        {timestamp ? (
          <time className="shrink-0 font-mono text-[10px] text-muted-foreground/70">{timestamp}</time>
        ) : null}
        <HugeiconsIcon
          aria-hidden="true"
          className="shrink-0 -rotate-90 transition-transform duration-150 group-open/tool:rotate-0"
          icon={ArrowDown01Icon}
          size={14}
        />
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
