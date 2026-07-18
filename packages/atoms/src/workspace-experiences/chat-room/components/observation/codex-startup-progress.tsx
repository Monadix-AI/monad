import type { AgentObservationEvent } from '@monad/protocol';

import { ObservationText } from '@monad/ui';

import { observationRawEvents } from './provenance.ts';

export type CodexMcpStartupUpdate = {
  name: string;
  status: string;
  error?: string;
};

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function codexMcpStartupUpdate(item: AgentObservationEvent): CodexMcpStartupUpdate | null {
  const raw = recordValue(observationRawEvents(item)[0]);
  if (raw?.method !== 'mcpServer/startupStatus/updated') return null;
  const params = recordValue(raw.params);
  if (!params) return null;
  const error = textValue(params.error);
  return {
    name: textValue(params.name) ?? 'unknown',
    status: textValue(params.status) ?? 'updated',
    ...(error ? { error } : {})
  };
}

export function collapseCodexMcpStartupUpdates(updates: readonly CodexMcpStartupUpdate[]): CodexMcpStartupUpdate[] {
  const collapsed: CodexMcpStartupUpdate[] = [];
  const indexByName = new Map<string, number>();
  for (const update of updates) {
    const index = indexByName.get(update.name);
    if (index === undefined) {
      indexByName.set(update.name, collapsed.length);
      collapsed.push(update);
    } else {
      collapsed[index] = update;
    }
  }
  return collapsed;
}

function codexMcpStartupText(update: CodexMcpStartupUpdate): string {
  const text = `MCP Server ${update.name} ${update.status}`;
  return update.error ? `${text}: ${update.error}` : text;
}

export function CodexMcpStartupProgressCard({
  updates
}: {
  updates: readonly CodexMcpStartupUpdate[];
}): React.ReactElement {
  return (
    <div className="grid gap-1.5">
      {updates.map((update) => (
        <ObservationText
          contained
          key={update.name}
          observationRole="system"
          text={codexMcpStartupText(update)}
        />
      ))}
    </div>
  );
}
