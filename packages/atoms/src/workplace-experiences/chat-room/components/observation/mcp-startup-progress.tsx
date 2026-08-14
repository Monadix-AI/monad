import type { IconSvgElement } from '@hugeicons/react';

import { ObservationMeta } from '@monad/ui';
import { siModelcontextprotocol } from 'simple-icons';

import { workplaceExperienceT } from '../../../i18n.ts';
import { ObservationToolCardShell, type ObservationToolStatus, ObservationToolStatusIndicator } from './card-shell.tsx';

const ModelContextProtocolIcon: IconSvgElement = [
  ['path', { d: siModelcontextprotocol.path, fill: 'currentColor', key: 'mcp' }]
];

export type McpStartupUpdate = {
  name: string;
  status: string;
  error?: string;
  failureReason?: string;
};

export type McpStartupView = {
  active?: string;
  failed: number;
  pending: number;
  ready: number;
  servers: readonly McpStartupUpdate[];
  skipped: number;
  total: number;
};

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function countValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function mcpStartupView(payload: Record<string, unknown>): McpStartupView {
  const servers = (Array.isArray(payload.servers) ? payload.servers : []).flatMap((entry) => {
    const record =
      entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>) : undefined;
    const name = textValue(record?.name);
    if (!name) return [];
    const error = textValue(record?.error);
    const failureReason = textValue(record?.failureReason);
    return [
      {
        name,
        status: textValue(record?.status) ?? 'updated',
        ...(error ? { error } : {}),
        ...(failureReason ? { failureReason } : {})
      }
    ];
  });
  const active = textValue(payload.active);
  return {
    ...(active ? { active } : {}),
    failed: countValue(payload.failed),
    pending: countValue(payload.pending),
    ready: countValue(payload.ready),
    servers,
    skipped: countValue(payload.skipped),
    total: countValue(payload.total) || servers.length
  };
}

function startupStatus(view: McpStartupView): ObservationToolStatus {
  if (view.pending > 0) return 'running';
  return view.failed > 0 ? 'error' : 'success';
}

function serverStatus(status: string): ObservationToolStatus | undefined {
  if (status === 'failed' || status === 'needs-auth') return 'error';
  if (status === 'cancelled' || status === 'canceled' || status === 'disabled') return undefined;
  return status === 'ready' || status === 'connected' ? 'success' : 'running';
}

function startupSummary(view: McpStartupView, t: ReturnType<typeof workplaceExperienceT>): string {
  const counts = { ready: view.ready, total: view.total };
  if (view.pending > 0) {
    return view.active
      ? t('web.workplace.mcpStartup.starting', { ...counts, name: view.active })
      : t('web.workplace.mcpStartup.startingUnnamed', counts);
  }
  if (view.failed > 0) return t('web.workplace.mcpStartup.settledWithFailures', { ...counts, failed: view.failed });
  return view.skipped > 0
    ? t('web.workplace.mcpStartup.settledWithSkipped', { ...counts, skipped: view.skipped })
    : t('web.workplace.mcpStartup.settled', counts);
}

function serverDetail(server: McpStartupUpdate): string | undefined {
  return server.error ?? server.failureReason;
}

export function McpStartupProgressCard({
  provider,
  timestamp,
  view
}: {
  provider: string;
  timestamp?: string;
  view: McpStartupView;
}): React.ReactElement {
  const t = workplaceExperienceT();
  const status = startupStatus(view);
  return (
    <ObservationToolCardShell
      header={
        <ObservationMeta
          compact
          quiet
          source={provider}
          title={startupSummary(view, t)}
        />
      }
      kind="mcp"
      runningIcon="kind"
      status={status}
      timestamp={timestamp}
      titleIcon={ModelContextProtocolIcon}
    >
      <div className="divide-y divide-border/70">
        {view.servers.map((server) => {
          const detail = serverDetail(server);
          return (
            <div
              className="grid gap-1 py-2"
              key={server.name}
            >
              <div className="flex min-w-0 items-center gap-2">
                <ObservationToolStatusIndicator status={serverStatus(server.status)} />
                <span className="min-w-0 flex-1 truncate font-ui text-foreground text-xs">{server.name}</span>
                <span className="shrink-0 font-ui text-[10px] text-muted-foreground uppercase">{server.status}</span>
              </div>
              {detail ? <p className="break-words font-ui text-destructive text-xs">{detail}</p> : null}
            </div>
          );
        })}
      </div>
    </ObservationToolCardShell>
  );
}
