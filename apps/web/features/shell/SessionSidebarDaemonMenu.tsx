'use client';

import type { NetworkRuntimeStatus, SystemUpgradeStatus } from '@monad/protocol';
import type { useT } from '#/components/I18nProvider';

import {
  Alert01Icon,
  ArrowRight01Icon,
  CircleCheckIcon,
  GlobeIcon,
  HouseIcon,
  LoaderPinwheelIcon,
  PlusSignIcon,
  ServerStack01Icon,
  Settings02Icon,
  SlidersHorizontalIcon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { useGetSystemUpgradeQuery, useStartSystemUpgradeMutation } from '@monad/client-rtk';
import { Button, cn, Tooltip, TooltipContent, TooltipTrigger } from '@monad/ui';
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useState } from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '#/components/ui/dropdown-menu';
import {
  daemonDisplayHost,
  getActiveDaemonConnection,
  LOCAL_DAEMON_ID,
  type RemoteDaemonConnection,
  readRemoteDaemonConnections,
  saveRemoteDaemonConnection
} from '#/lib/daemon-connections';
import { watchUpgradeRestartAndReload } from '#/lib/monad-store';
import { RemoteDaemonDialog } from './SessionSidebarRemoteDaemonDialog';

type TFunction = ReturnType<typeof useT>;

function DaemonMenuTile({
  active,
  icon: Icon,
  label,
  onSelect
}: {
  active: boolean;
  icon: IconSvgElement;
  label: string;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem
      className={cn(
        'flex min-h-18 flex-col items-center justify-center gap-2 rounded-md px-2.5 py-3 text-center font-normal text-base leading-control outline-hidden transition focus:bg-accent focus:text-accent-foreground',
        active && 'bg-accent text-accent-foreground'
      )}
      onSelect={(event) => {
        event.preventDefault();
        onSelect();
      }}
    >
      <span className="grid size-8 place-items-center rounded-sm border border-border bg-background/60">
        <HugeiconsIcon
          className="size-4"
          icon={Icon}
        />
      </span>
      <span className="font-normal">{label}</span>
    </DropdownMenuItem>
  );
}

function DaemonConnectionItem({
  active,
  label,
  meta,
  onSelect,
  statusClass,
  statusText,
  version
}: {
  active: boolean;
  label: string;
  meta: string;
  onSelect: () => void;
  statusClass?: string;
  statusText?: string;
  version?: string;
}) {
  const showDetails = Boolean(statusText || version);

  return (
    <DropdownMenuItem
      className={cn('items-center gap-2.5 py-2', active && 'bg-accent text-accent-foreground')}
      onSelect={onSelect}
    >
      <HugeiconsIcon
        className="size-4"
        icon={ServerStack01Icon}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-sm">{label}</span>
        <span className="block truncate text-muted-foreground text-xs">{meta}</span>
      </span>
      {showDetails ? (
        <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
          {statusText ? (
            <span className="inline-flex items-center gap-1 text-[11px] leading-none">
              {statusClass ? <span className={cn('size-1.5 rounded-full', statusClass)} /> : null}
              {statusText}
            </span>
          ) : null}
          {version ? <span className="font-mono text-[10px] leading-none">v{version}</span> : null}
        </span>
      ) : null}
      {active ? (
        <HugeiconsIcon
          className="size-4 text-success"
          icon={CircleCheckIcon}
        />
      ) : null}
    </DropdownMenuItem>
  );
}

export function DaemonMenu({
  daemonBaseUrl,
  daemonStatus,
  daemonStatusClass,
  daemonStatusText,
  daemonVersion,
  networkRuntime,
  menuOpen,
  onOpenChange,
  onOpenStudio,
  onOpenWorkspace,
  onToggleSettings,
  shortcutModifierLabel,
  onSwitchDaemonConnection,
  showSettings,
  studioPileActive,
  t,
  workspacePileActive
}: {
  daemonBaseUrl: string;
  daemonStatus: 'checking' | 'online' | 'offline';
  daemonStatusClass: string;
  daemonStatusText: string;
  daemonVersion?: string;
  hasUpgrade?: boolean;
  networkRuntime?: NetworkRuntimeStatus;
  menuOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenStudio: () => void;
  onOpenWorkspace: () => void;
  onToggleSettings: () => void;
  shortcutModifierLabel: string;
  onSwitchDaemonConnection: (
    request: { type: 'local' } | { connection: RemoteDaemonConnection; type: 'remote' }
  ) => void;
  showSettings: boolean;
  studioPileActive: boolean;
  t: TFunction;
  workspacePileActive: boolean;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [remoteConnections, setRemoteConnections] = useState<RemoteDaemonConnection[]>([]);
  const [activeConnection, setActiveConnection] = useState(() => getActiveDaemonConnection(daemonBaseUrl));
  const [showConnectionLabel, setShowConnectionLabel] = useState(false);
  const [upgradePolling, setUpgradePolling] = useState(false);
  const [startSystemUpgrade, { isLoading: isStartingUpgrade }] = useStartSystemUpgradeMutation();
  const { data: upgradeStatus } = useGetSystemUpgradeQuery(undefined, {
    pollingInterval: menuOpen || isStartingUpgrade || upgradePolling ? 1000 : 0,
    skip: daemonStatus !== 'online' || (!menuOpen && !isStartingUpgrade && !upgradePolling)
  });
  const hasConnectionChoices = remoteConnections.length > 0;
  const activeConnectionMeta = daemonStatus === 'online' ? 'Connected' : daemonStatusText;
  const activeConnectionVersion = daemonStatus === 'online' ? daemonVersion : undefined;
  const runtimeIcon = networkRuntime?.lastError
    ? Alert01Icon
    : networkRuntime?.remoteAccess.enabled
      ? GlobeIcon
      : undefined;
  const runtimeIconClass = networkRuntime?.lastError
    ? 'text-destructive'
    : networkRuntime?.remoteAccess.enabled
      ? 'text-accent-blue'
      : 'text-muted-foreground';
  const runtimeListeners = networkRuntime?.listeners.map(
    (listener) => `${listener.scheme}://${listener.host}:${listener.port}`
  );
  const upgradeStage = upgradeStatus?.stage ?? 'idle';
  const upgradeActive = upgradeStatusIsActive(upgradeStage) || isStartingUpgrade;
  const upgradeReady = upgradeStatus?.available === true && upgradeStatus.stage === 'ready';
  const upgradeLabel = upgradeActive ? upgradeDisplayLabel(upgradeStage) : 'Relaunch to update';

  useEffect(() => {
    setUpgradePolling(upgradeStatusIsActive(upgradeStage) || isStartingUpgrade);
  }, [isStartingUpgrade, upgradeStage]);

  useEffect(() => {
    setRemoteConnections(readRemoteDaemonConnections());
    setActiveConnection(getActiveDaemonConnection(daemonBaseUrl));
  }, [daemonBaseUrl]);

  useEffect(() => {
    if (!hasConnectionChoices) {
      setShowConnectionLabel(false);
      return;
    }

    setShowConnectionLabel(true);
    const interval = window.setInterval(() => {
      setShowConnectionLabel((visible) => !visible);
    }, 3200);
    return () => window.clearInterval(interval);
  }, [hasConnectionChoices]);

  const onSelectLocalDaemon = () => {
    if (activeConnection.id === LOCAL_DAEMON_ID) return;
    onSwitchDaemonConnection({ type: 'local' });
  };

  const onSelectRemoteDaemon = (connection: RemoteDaemonConnection) => {
    if (activeConnection.id === connection.id) return;
    const saved = saveRemoteDaemonConnection(connection);
    onSwitchDaemonConnection({ connection: saved, type: 'remote' });
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.altKey || event.shiftKey) return;
    if (!event.metaKey && !event.ctrlKey) return;
    if (event.key !== ',') return;

    event.preventDefault();
    onToggleSettings();
  };

  const startUpgrade = async () => {
    if (upgradeActive) return;
    watchUpgradeRestartAndReload({
      baseUrl: daemonBaseUrl,
      currentVersion: daemonVersion,
      targetVersion: upgradeStatus?.latestVersion
    });
    await startSystemUpgrade().unwrap();
  };

  return (
    <>
      <DropdownMenu
        onOpenChange={onOpenChange}
        open={menuOpen}
      >
        <div className="relative flex min-w-0 flex-1">
          <DropdownMenuTrigger asChild>
            <button
              className={cn(
                'flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                (showSettings || menuOpen) &&
                  'bg-sidebar-selected text-sidebar-selected-foreground hover:bg-sidebar-selected-hover'
              )}
              type="button"
            >
              <div className="rounded-full border border-border/80 bg-background/60 p-1.5">
                <HugeiconsIcon
                  className="size-4"
                  icon={ServerStack01Icon}
                />
              </div>
              {runtimeIcon ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className="grid size-5 shrink-0 place-items-center rounded-full border border-border bg-background"
                      data-testid="daemon-runtime-status"
                    >
                      <HugeiconsIcon
                        className={cn('size-3.5', runtimeIconClass)}
                        icon={runtimeIcon}
                      />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-72">
                    <div className="flex flex-col gap-1 text-xs">
                      <span className="font-medium">{t('web.daemon.runtimeStatus')}</span>
                      {runtimeListeners?.length ? <span>{runtimeListeners.join(', ')}</span> : null}
                      <span>
                        {t('web.daemon.tokenRevision', {
                          revision: networkRuntime?.remoteAccess.tokenRevision ?? 0
                        })}
                      </span>
                      {networkRuntime?.lastError ? (
                        <span className="text-destructive">{networkRuntime.lastError.message}</span>
                      ) : null}
                    </div>
                  </TooltipContent>
                </Tooltip>
              ) : null}
              {showConnectionLabel ? (
                <span className="min-w-0 flex-1 font-normal leading-tight">
                  <span className="block truncate text-ui">{activeConnection.label}</span>
                  <span className="block truncate text-muted-foreground text-xs">{activeConnectionMeta}</span>
                </span>
              ) : (
                <span className="min-w-0 flex-1 font-normal text-ui leading-control">{t('web.daemon.label')}</span>
              )}
            </button>
          </DropdownMenuTrigger>
        </div>
        <DropdownMenuContent
          align="start"
          className="w-[min(20rem,calc(100vw-1rem))]"
          onKeyDown={onMenuKeyDown}
          side="top"
        >
          {upgradeReady || upgradeActive ? (
            <>
              <DropdownMenuItem
                className="mb-1 flex min-h-16 items-center gap-3 rounded-md border border-border bg-card px-3 py-3 outline-hidden focus:bg-accent"
                disabled={upgradeActive}
                onSelect={(event) => {
                  event.preventDefault();
                  void startUpgrade();
                }}
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-sm border bg-background/70">
                  <HugeiconsIcon
                    className={cn('size-5', upgradeActive && 'animate-spin')}
                    icon={upgradeActive ? LoaderPinwheelIcon : CircleCheckIcon}
                  />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-base">{upgradeLabel}</span>
                  {upgradeStatus?.latestVersion ? (
                    <span className="block truncate font-mono text-muted-foreground text-xs">
                      v{upgradeStatus.latestVersion}
                    </span>
                  ) : null}
                </span>
                {!upgradeActive ? (
                  <HugeiconsIcon
                    className="size-5 text-muted-foreground"
                    icon={ArrowRight01Icon}
                  />
                ) : null}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuGroup>
            <DropdownMenuLabel className="flex items-center gap-2 font-normal text-base leading-control">
              <span className="text-foreground">{t('web.daemon.label')}</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    aria-label={t('web.daemon.connectRemote')}
                    className="ml-auto size-7 shrink-0"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setDialogOpen(true);
                    }}
                    size="icon"
                    variant="ghost"
                  >
                    <HugeiconsIcon icon={PlusSignIcon} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('web.daemon.connectRemote')}</TooltipContent>
              </Tooltip>
            </DropdownMenuLabel>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DaemonConnectionItem
              active={activeConnection.id === LOCAL_DAEMON_ID}
              label={t('web.daemon.local')}
              meta={daemonDisplayHost(daemonBaseUrl)}
              onSelect={onSelectLocalDaemon}
              statusClass={activeConnection.id === LOCAL_DAEMON_ID ? daemonStatusClass : undefined}
              statusText={activeConnection.id === LOCAL_DAEMON_ID ? daemonStatusText : undefined}
              version={activeConnection.id === LOCAL_DAEMON_ID ? activeConnectionVersion : undefined}
            />
            {remoteConnections.map((connection) => (
              <DaemonConnectionItem
                active={activeConnection.id === connection.id}
                key={connection.id}
                label={connection.label}
                meta={connection.url}
                onSelect={() => onSelectRemoteDaemon(connection)}
                statusClass={activeConnection.id === connection.id ? daemonStatusClass : undefined}
                statusText={activeConnection.id === connection.id ? daemonStatusText : undefined}
                version={activeConnection.id === connection.id ? activeConnectionVersion : connection.version}
              />
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup className="grid grid-cols-2 gap-1">
            <DaemonMenuTile
              active={workspacePileActive}
              icon={HouseIcon}
              label={t('web.workspace.title')}
              onSelect={onOpenWorkspace}
            />
            <DaemonMenuTile
              active={studioPileActive}
              icon={SlidersHorizontalIcon}
              label={t('web.studio.title')}
              onSelect={onOpenStudio}
            />
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem
              className={cn(showSettings && 'bg-accent text-accent-foreground')}
              onSelect={onToggleSettings}
            >
              <HugeiconsIcon
                className="size-4"
                icon={Settings02Icon}
              />
              <span>{t('web.sidebar.settings')}</span>
              <DropdownMenuShortcut>
                {shortcutModifierLabel}
                {','}
              </DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <RemoteDaemonDialog
        onConnected={(connection) => {
          setRemoteConnections((connections) => [
            connection,
            ...connections.filter((existing) => existing.id !== connection.id)
          ]);
          setActiveConnection({
            id: connection.id,
            label: connection.label,
            type: 'remote',
            url: connection.url
          });
          onSwitchDaemonConnection({ connection, type: 'remote' });
          setDialogOpen(false);
        }}
        onOpenChange={setDialogOpen}
        open={dialogOpen}
      />
    </>
  );
}

function upgradeStatusIsActive(stage: SystemUpgradeStatus['stage']): boolean {
  return (
    stage === 'checking' ||
    stage === 'downloading' ||
    stage === 'verifying' ||
    stage === 'installing' ||
    stage === 'restarting'
  );
}

function upgradeDisplayLabel(stage: SystemUpgradeStatus['stage']): string {
  if (stage === 'installing') return 'Installing';
  if (stage === 'restarting' || stage === 'complete') return 'Restart';
  return 'Downloading';
}
