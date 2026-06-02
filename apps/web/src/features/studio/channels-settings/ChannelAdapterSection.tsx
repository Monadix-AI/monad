import type { ChannelInstanceView, ChannelStatus } from '@monad/protocol';
import type { InstalledChannelOption } from './installed-channel-options';

import { Add01Icon, Alert02Icon, Edit02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button, cn, MorphChevron, Switch } from '@monad/ui';
import { useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { ChannelBrandIcon } from './ChannelBrandIcon';
import { ChannelConnectionDialog } from './ChannelConnectionDialog';

type DialogState = { connection?: ChannelInstanceView } | null;

export function ChannelAdapterSection({
  adapter,
  connections,
  expanded,
  statusById,
  onExpandedChange,
  onPair,
  onRemove,
  onSave,
  onSetCredential,
  onToggle
}: {
  adapter: InstalledChannelOption;
  connections: ChannelInstanceView[];
  expanded: boolean;
  statusById: Map<string, ChannelStatus>;
  onExpandedChange: (expanded: boolean) => void;
  onRemove: (id: string) => Promise<void>;
  onPair: (id: ChannelInstanceView['id']) => Promise<void>;
  onSave: (connection: ChannelInstanceView) => Promise<void>;
  onSetCredential: (
    id: ChannelInstanceView['id'],
    value: { token: string; extra?: Record<string, string> }
  ) => Promise<void>;
  onToggle: (connection: ChannelInstanceView, enabled: boolean) => Promise<void>;
}) {
  const t = useT();
  const [dialog, setDialog] = useState<DialogState>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  const [toggleErrors, setToggleErrors] = useState<Record<string, string>>({});
  const available = adapter.available !== false;

  const toggle = async (connection: ChannelInstanceView, enabled: boolean) => {
    setBusyIds((current) => new Set(current).add(connection.id));
    setToggleErrors((current) => {
      const { [connection.id]: _removed, ...rest } = current;
      return rest;
    });
    try {
      await onToggle(connection, enabled);
    } catch (error) {
      setToggleErrors((current) => ({
        ...current,
        [connection.id]: error instanceof Error ? error.message : t('web.ch.toggleFailed')
      }));
    } finally {
      setBusyIds((current) => {
        const next = new Set(current);
        next.delete(connection.id);
        return next;
      });
    }
  };

  return (
    <section className="rounded-lg border bg-card/40">
      <div className="flex items-center gap-3 px-3 py-3">
        <button
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          onClick={() => onExpandedChange(!expanded)}
          type="button"
        >
          <ChannelBrandIcon icon={adapter.icon} />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate font-medium text-sm">{adapter.label}</span>
            <span className="text-muted-foreground text-xs">
              {t('web.ch.connectionCount', { count: connections.length })}
            </span>
          </span>
          <MorphChevron
            className="size-4 text-muted-foreground"
            expanded={expanded}
          />
        </button>
        <Button
          disabled={!available}
          onClick={() => setDialog({})}
          size="sm"
          variant="ghost"
        >
          <HugeiconsIcon icon={Add01Icon} />
          {t('web.ch.addConnection')}
        </Button>
      </div>

      {expanded ? (
        <div className="border-t px-3 py-2">
          {connections.length === 0 ? (
            <p className="py-4 text-center text-muted-foreground text-xs">{t('web.ch.noConnections')}</p>
          ) : (
            <ul className="divide-y">
              {connections.map((connection) => {
                const status = statusById.get(connection.id);
                const toggleError = toggleErrors[connection.id];
                return (
                  <li
                    className="flex flex-col py-2.5"
                    key={connection.id}
                  >
                    <div className="flex items-center gap-3">
                      <span
                        aria-label={
                          status
                            ? status.phase === 'pairing'
                              ? t('web.ch.awaitingPairing')
                              : status.connected
                                ? t('web.ch.connected')
                                : t('web.ch.disconnected')
                            : t('web.ch.statusUnavailable')
                        }
                        className={cn(
                          'size-2 shrink-0 rounded-full',
                          status?.connected
                            ? 'bg-green-500'
                            : status?.phase === 'pairing'
                              ? 'bg-amber-500'
                              : status
                                ? 'bg-muted-foreground/35'
                                : 'bg-amber-500/70'
                        )}
                        role="img"
                      />
                      <button
                        className="flex min-w-0 flex-1 flex-col text-left"
                        onClick={() => setDialog({ connection })}
                        type="button"
                      >
                        <span className="truncate font-medium text-sm">{connection.label}</span>
                        <span className="truncate text-[11px] text-muted-foreground">{connection.id}</span>
                      </button>
                      {adapter.connectionMode === 'credential' && !connection.credentialConfigured ? (
                        <span className="flex items-center gap-1 text-amber-600 text-xs dark:text-amber-400">
                          <HugeiconsIcon
                            className="size-3.5"
                            icon={Alert02Icon}
                          />
                          {t('web.ch.credentialsMissing')}
                        </span>
                      ) : null}
                      <Button
                        aria-label={t('web.ch.editConnection', { name: connection.label })}
                        onClick={() => setDialog({ connection })}
                        size="icon-sm"
                        variant="ghost"
                      >
                        <HugeiconsIcon icon={Edit02Icon} />
                      </Button>
                      <Switch
                        aria-label={t('web.ch.toggleConnection', { name: connection.label })}
                        checked={connection.enabled}
                        disabled={busyIds.has(connection.id) || (!available && !connection.enabled)}
                        onCheckedChange={(enabled) => void toggle(connection, enabled)}
                      />
                    </div>
                    {toggleError ? <p className="pt-1 pl-5 text-destructive text-xs">{toggleError}</p> : null}
                  </li>
                );
              })}
            </ul>
          )}
          {!available ? (
            <p className="py-2 text-amber-600 text-xs dark:text-amber-400">{t('web.ch.adapterUnavailable')}</p>
          ) : null}
        </div>
      ) : null}

      {dialog ? (
        <ChannelConnectionDialog
          adapter={adapter}
          connection={dialog.connection}
          onClose={() => setDialog(null)}
          onPair={onPair}
          onRemove={onRemove}
          onSave={onSave}
          onSetCredential={onSetCredential}
          statusById={statusById}
        />
      ) : null}
    </section>
  );
}
