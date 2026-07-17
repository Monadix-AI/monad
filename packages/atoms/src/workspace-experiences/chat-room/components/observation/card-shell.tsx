import type { ObservationVisualRole, RawEventRecord } from '@monad/ui';

import { ObservationCard, RawInspectableCard } from '@monad/ui';
import { useEffect, useState } from 'react';

import { workspaceExperienceT } from '../../../i18n.ts';

export type ObservationCollapseCommand = {
  collapsed: boolean;
};

export function ObservationCardShell({
  children,
  collapseCommand,
  defaultCollapsed = false,
  header,
  raw,
  timestamp,
  visualRole
}: {
  children: React.ReactNode;
  collapseCommand?: ObservationCollapseCommand;
  defaultCollapsed?: boolean;
  header?: React.ReactNode;
  raw: unknown;
  timestamp?: string;
  visualRole: ObservationVisualRole;
}): React.ReactElement {
  const t = workspaceExperienceT();
  const [collapsed, setCollapsedState] = useState(collapseCommand?.collapsed ?? defaultCollapsed);
  const [rawOpen, setRawOpen] = useState(false);
  const commandCollapsed = collapseCommand?.collapsed;
  const records = rawEventRecords(raw);

  useEffect(() => {
    if (commandCollapsed === undefined) return;
    setCollapsedState(commandCollapsed);
    if (commandCollapsed) setRawOpen(false);
  }, [commandCollapsed]);

  const setCollapsed = (next: boolean): void => {
    setCollapsedState(next);
    if (next) setRawOpen(false);
  };

  return (
    <RawInspectableCard
      labels={{
        copy: t('web.workplace.copyRawJson'),
        hide: t('web.workplace.hideRawJsonl'),
        show: t('web.workplace.showRawJsonl')
      }}
      onCopy={(text) => void navigator.clipboard?.writeText(text)}
      onOpenChange={setRawOpen}
      open={rawOpen}
      records={records}
    >
      <ObservationCard
        collapsed={collapsed}
        header={header}
        onCollapsedChange={setCollapsed}
        timestamp={timestamp}
        visualRole={visualRole}
      >
        {children}
      </ObservationCard>
    </RawInspectableCard>
  );
}

export function rawJsonText(raw: unknown): string {
  if (raw === undefined) return 'null';
  if (Array.isArray(raw)) return raw.map(rawRecordText).join('\n');
  return rawRecordText(raw);
}

function rawEventRecords(raw: unknown): RawEventRecord[] {
  if (raw === undefined) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  return values.map((value, index) => ({ id: `raw:${index}`, text: rawRecordText(value) }));
}

export function toolCallSummary(text: string): string {
  const match = /^Tool call\s+([^\s]+)\s+(.+)$/s.exec(text.trim());
  if (!match) return text;
  const [, tool, rawInput] = match;
  if (!tool || rawInput === undefined) return text;
  try {
    const parsed = JSON.parse(rawInput) as unknown;
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
