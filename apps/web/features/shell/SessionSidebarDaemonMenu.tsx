'use client';

import type { SystemUpgradeStatus } from '@monad/protocol';
import type { useT } from '@/components/I18nProvider';

import {
  CircleCheckIcon,
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
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useRef,
  useState
} from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import {
  daemonDisplayHost,
  getActiveDaemonConnection,
  LOCAL_DAEMON_ID,
  type RemoteDaemonConnection,
  readRemoteDaemonConnections,
  saveRemoteDaemonConnection
} from '@/lib/daemon-connections';
import { markUpgradeRestartWindow } from '@/lib/monad-store';
import { RemoteDaemonDialog } from './SessionSidebarRemoteDaemonDialog';

type TFunction = ReturnType<typeof useT>;

function DaemonMenuTile({
  active,
  icon: Icon,
  label,
  onClick
}: {
  active: boolean;
  icon: IconSvgElement;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={cn(
        'flex min-h-18 flex-col items-center justify-center gap-2 rounded-(--radius-md) px-2.5 py-3 text-center font-normal text-base leading-control outline-hidden transition hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground',
        active && 'bg-accent text-accent-foreground'
      )}
      onClick={onClick}
      type="button"
    >
      <span className="grid size-8 place-items-center rounded-(--radius-sm) border border-border bg-background/60">
        <HugeiconsIcon
          className="size-4"
          icon={Icon}
        />
      </span>
      <span className="font-normal">{label}</span>
    </button>
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
  hasUpgrade,
  menuOpen,
  onOpenChange,
  onOpenWorkspace,
  onToggleSettings,
  onToggleStudio,
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
  menuOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenWorkspace: () => void;
  onToggleSettings: () => void;
  onToggleStudio: () => void;
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
  const reloadScheduledRef = useRef(false);
  const { data: upgradeStatus } = useGetSystemUpgradeQuery(undefined, {
    pollingInterval: hasUpgrade ? 1000 : 0,
    skip: !hasUpgrade
  });
  const [startSystemUpgrade, { isLoading: isStartingUpgrade }] = useStartSystemUpgradeMutation();
  const hasConnectionChoices = remoteConnections.length > 0;
  const activeConnectionMeta = daemonStatus === 'online' ? 'Connected' : daemonStatusText;
  const activeConnectionVersion = daemonStatus === 'online' ? daemonVersion : undefined;
  const upgradeStage = upgradeStatus?.stage ?? 'idle';
  const upgradeActive = upgradeStatusIsActive(upgradeStage) || isStartingUpgrade;
  const upgradeLabel = upgradeActive ? upgradeDisplayLabel(upgradeStage) : 'Update';

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

  useEffect(() => {
    if ((upgradeStatus?.stage !== 'restarting' && upgradeStatus?.stage !== 'complete') || reloadScheduledRef.current) {
      return;
    }
    reloadScheduledRef.current = true;
    const timeout = window.setTimeout(() => window.location.reload(), 2000);
    return () => window.clearTimeout(timeout);
  }, [upgradeStatus?.stage]);

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
    markUpgradeRestartWindow();
    await startSystemUpgrade().unwrap();
  };

  const onUpgradeClick = async (event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    await startUpgrade();
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
                'flex min-w-0 flex-1 items-center gap-2.5 rounded-(--radius-md) px-2.5 py-2 text-left transition hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                hasUpgrade && 'pr-24',
                (showSettings || menuOpen) && 'bg-sidebar-accent text-sidebar-accent-foreground'
              )}
              type="button"
            >
              <div className="rounded-full border border-border/80 bg-background/60 p-1.5">
                <HugeiconsIcon
                  className="size-4"
                  icon={ServerStack01Icon}
                />
              </div>
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
          {hasUpgrade ? (
            <button
              aria-label={upgradeLabel}
              className={cn(
                'absolute top-1/2 right-1.5 -mt-px inline-flex h-4 min-w-7 shrink-0 -translate-y-1/2 items-center justify-center gap-px rounded-full border border-accent-blue/30 bg-accent-blue/10 px-1.5 font-medium text-[10px] text-accent-blue leading-none shadow-[inset_0_1px_0_rgb(255_255_255/0.08)] backdrop-blur',
                !upgradeActive && 'hover:bg-accent-blue/15'
              )}
              disabled={upgradeActive}
              onClick={onUpgradeClick}
              type="button"
            >
              {upgradeActive ? (
                <HugeiconsIcon
                  className="size-3 animate-spin"
                  icon={LoaderPinwheelIcon}
                />
              ) : null}
              {upgradeLabel}
            </button>
          ) : null}
        </div>
        <DropdownMenuContent
          align="start"
          className="w-[min(20rem,calc(100vw-1rem))]"
          onKeyDown={onMenuKeyDown}
          side="top"
        >
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
              label="Workplace"
              onClick={onOpenWorkspace}
            />
            <DaemonMenuTile
              active={studioPileActive}
              icon={SlidersHorizontalIcon}
              label={t('web.studio.title')}
              onClick={onToggleStudio}
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
              {hasUpgrade ? (
                <span className="ml-auto rounded-full border border-accent-blue/30 bg-accent-blue/10 px-2 py-0.5 font-medium text-[10px] text-accent-blue leading-none">
                  Update
                </span>
              ) : null}
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
