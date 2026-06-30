'use client';

import type { VersionCheckResult } from '@monad/client';

import { checkDaemonVersion } from '@monad/client';
import { Button, cn, Input, Label, Tooltip, TooltipContent, TooltipTrigger } from '@monad/ui';
import {
  AlertCircle,
  CircleCheck,
  House,
  LinkIcon,
  Loader2,
  type LucideIcon,
  MessageSquare,
  PanelLeftClose,
  Plus,
  Server,
  Settings2,
  SlidersHorizontal
} from 'lucide-react';
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState
} from 'react';

import { useT } from '@/components/I18nProvider';
import { MonadLogo } from '@/components/MonadLogo';
import { ThemeToggle } from '@/components/ThemeToggle';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
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
  STUDIO_AGENT_SECTIONS,
  STUDIO_CAPABILITY_SECTIONS,
  STUDIO_RUNTIME_SECTIONS,
  STUDIO_USAGE_SECTION,
  type StudioSectionId,
  type StudioSectionItem
} from '@/features/studio/sections';
import {
  daemonDisplayHost,
  getActiveDaemonConnection,
  LOCAL_DAEMON_ID,
  normalizeDaemonUrl,
  type RemoteDaemonConnection,
  readRemoteDaemonConnections,
  saveRemoteDaemonConnection
} from '@/lib/daemon-connections';

interface ProjectItem {
  id: string;
  name: string;
}

type TFunction = ReturnType<typeof useT>;

interface Props {
  autoCollapseOnPointerLeave?: boolean;
  projects: ProjectItem[];
  collapsed: boolean;
  overlay?: boolean;
  hasUpgrade?: boolean;
  showSettings: boolean;
  showStudio: boolean;
  studioPileActive: boolean;
  workspacePileActive: boolean;
  monadChatActive: boolean;
  activeProjectId: string | null;
  daemonBaseUrl: string;
  daemonStatus: 'checking' | 'online' | 'offline';
  daemonVersion?: string;
  studioSection: StudioSectionId;
  shortcutModifierLabel?: string;
  showShortcutBadges?: boolean;
  onOpenWorkspace: () => void;
  onOpenMonadChat: () => void;
  onOpenProject: (id: string) => void;
  onOpenStudioSection: (section: StudioSectionId) => void;
  onRequestCollapse?: () => void;
  onRequestPersistentExpand?: () => void;
  onSwitchDaemonConnection: (
    request: { type: 'local' } | { connection: RemoteDaemonConnection; type: 'remote' }
  ) => void;
  onToggleCollapsed: () => void;
  onToggleSettings: () => void;
  onToggleStudio: () => void;
}

const DEFAULT_SIDEBAR_WIDTH = 288;
const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 420;
const SIDEBAR_WIDTH_STORAGE_KEY = 'monad:web:sidebar-width';
const STUDIO_SHORTCUT_ITEMS = [
  ...STUDIO_AGENT_SECTIONS,
  ...STUDIO_CAPABILITY_SECTIONS,
  ...STUDIO_RUNTIME_SECTIONS,
  STUDIO_USAGE_SECTION
];

function clampSidebarWidth(width: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

function ShortcutBadge({ modifierLabel, number }: { modifierLabel: string; number: number }) {
  return (
    <span className="mt-0.5 inline-flex h-6 min-w-11 shrink-0 items-center justify-center gap-0.5 rounded-full bg-sidebar-accent/80 px-2 font-medium text-[13px] text-sidebar-foreground/70 tabular-nums shadow-[inset_0_1px_0_rgb(255_255_255/0.08)] backdrop-blur">
      {modifierLabel}
      {number}
    </span>
  );
}
function SidebarNavSection({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 py-1.5">
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

function SidebarNavItem({
  active,
  children,
  icon: Icon,
  label,
  onClick,
  shortcutModifierLabel,
  shortcutNumber
}: {
  active?: boolean;
  children?: ReactNode;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  shortcutModifierLabel?: string;
  shortcutNumber?: number;
}) {
  return (
    <button
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group/item flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-(--radius-md) px-2.5 py-2 text-left transition hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
        active && 'bg-sidebar-accent text-sidebar-accent-foreground'
      )}
      onClick={onClick}
      type="button"
    >
      <div className="rounded-full border border-transparent bg-transparent p-1.5">
        <Icon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-normal text-ui leading-control">{label}</div>
        {children}
      </div>
      {shortcutNumber && shortcutModifierLabel ? (
        <span className="opacity-0 transition-opacity duration-150 group-hover/item:opacity-100 group-hover/item:delay-500">
          <ShortcutBadge
            modifierLabel={shortcutModifierLabel}
            number={shortcutNumber}
          />
        </span>
      ) : null}
    </button>
  );
}

function SidebarHeader({
  onOpenWorkspace,
  onToggleCollapsed,
  t
}: {
  onOpenWorkspace: () => void;
  onToggleCollapsed: () => void;
  t: TFunction;
}) {
  return (
    <div className="px-4 pt-3.5 pb-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center">
          <button
            className="poster-heading cursor-pointer text-sidebar-primary transition hover:text-sidebar-foreground"
            onClick={onOpenWorkspace}
            type="button"
          >
            <MonadLogo className="h-6 w-[4.75rem]" />
          </button>
        </div>
        <div className="flex items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label={t('web.sidebar.collapse')}
                className="size-7"
                onClick={onToggleCollapsed}
                size="icon"
                variant="ghost"
              >
                <PanelLeftClose />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('web.sidebar.collapse')}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

function StudioSidebarItems({
  activeSection,
  onSelect,
  shortcutModifierLabel,
  showShortcutBadges,
  t
}: {
  activeSection: StudioSectionId;
  onSelect: (section: StudioSectionId) => void;
  shortcutModifierLabel: string;
  t: TFunction;
  showShortcutBadges?: boolean;
}) {
  const shortcutNumbers = new Map(STUDIO_SHORTCUT_ITEMS.slice(0, 9).map((item, index) => [item.id, index + 1]));
  const renderItem = ({ id, icon, i18nKey }: StudioSectionItem) => (
    <SidebarNavItem
      active={activeSection === id}
      icon={icon}
      key={id}
      label={t(i18nKey)}
      onClick={() => onSelect(id)}
      shortcutModifierLabel={shortcutModifierLabel}
      shortcutNumber={showShortcutBadges ? shortcutNumbers.get(id) : undefined}
    />
  );

  return (
    <>
      <div className="sidebar-scroll-area min-h-0 flex-1 overflow-y-auto">
        <SidebarNavSection>{STUDIO_AGENT_SECTIONS.map(renderItem)}</SidebarNavSection>
        <SidebarNavSection>{STUDIO_CAPABILITY_SECTIONS.map(renderItem)}</SidebarNavSection>
        <SidebarNavSection>{STUDIO_RUNTIME_SECTIONS.map(renderItem)}</SidebarNavSection>
      </div>
      <SidebarNavSection>{renderItem(STUDIO_USAGE_SECTION)}</SidebarNavSection>
    </>
  );
}

function ProjectList({
  activeProjectId,
  projects,
  onOpenProject,
  t
}: {
  activeProjectId: string | null;
  projects: ProjectItem[];
  onOpenProject: (id: string) => void;
  t: TFunction;
}) {
  return (
    <>
      <div className="flex items-center justify-between px-3 pt-3 pb-2">
        <div>
          <span className="panel-kicker">{t('web.sidebar.channels')}</span>
          <div className="mt-1 text-[11px] text-muted-foreground">{projects.length}</div>
        </div>
      </div>

      <div className="sidebar-scroll-area min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-1 px-2.5 pb-3">
          {projects.map((project) => (
            <button
              aria-current={activeProjectId === project.id ? 'page' : undefined}
              className={cn(
                'flex cursor-pointer flex-col items-start gap-0.5 rounded-(--radius-md) px-2.5 py-2 text-left transition hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                activeProjectId === project.id && 'bg-sidebar-accent text-sidebar-accent-foreground'
              )}
              key={project.id}
              onClick={() => onOpenProject(project.id)}
              type="button"
            >
              <span className="label-mono">{t('web.workplace.projectBadge')}</span>
              <span className="line-clamp-2 font-normal text-ui leading-control">{project.name}</span>
            </button>
          ))}
          {projects.length === 0 && (
            <p className="px-2 py-2 text-muted-foreground text-xs">{t('web.workplace.noProjects')}</p>
          )}
        </div>
      </div>
    </>
  );
}

function WorkspaceSidebarItems({
  activeProjectId,
  monadChatActive,
  onOpenProject,
  onOpenMonadChat,
  projects,
  t
}: {
  activeProjectId: string | null;
  monadChatActive: boolean;
  onOpenProject: (id: string) => void;
  onOpenMonadChat: () => void;
  projects: ProjectItem[];
  t: TFunction;
}) {
  return (
    <>
      <SidebarNavSection>
        <SidebarNavItem
          active={monadChatActive}
          icon={MessageSquare}
          label={t('web.sidebar.monadAgent')}
          onClick={onOpenMonadChat}
        >
          <div className="mt-1 text-muted-foreground text-sm">{t('web.sidebar.monadAgentHint')}</div>
        </SidebarNavItem>
      </SidebarNavSection>
      <ProjectList
        activeProjectId={activeProjectId}
        onOpenProject={onOpenProject}
        projects={projects}
        t={t}
      />
    </>
  );
}

function DaemonMenuTile({
  active,
  icon: Icon,
  label,
  onClick
}: {
  active: boolean;
  icon: LucideIcon;
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
        <Icon className="size-4" />
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
      <Server className="size-4" />
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
      {active ? <CircleCheck className="size-4 text-success" /> : null}
    </DropdownMenuItem>
  );
}

function RemoteDaemonDialog({
  onConnected,
  onOpenChange,
  open
}: {
  onConnected: (connection: RemoteDaemonConnection) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<
    { status: 'idle' } | { status: 'checking' } | { result: VersionCheckResult; status: 'done' }
  >({ status: 'idle' });
  const checking = check.status === 'checking';
  const trimmedUrl = url.trim();
  const normalizedPreview = trimmedUrl ? normalizeDaemonUrl(trimmedUrl) : null;
  const previewUrl = normalizedPreview && !normalizedPreview.error ? normalizedPreview.url : null;

  const reset = () => {
    setError(null);
    setCheck({ status: 'idle' });
  };

  async function handleConnect() {
    const normalized = normalizeDaemonUrl(url);
    if (normalized.error) {
      setError(normalized.error);
      return;
    }
    const normalizedUrl = normalized.url;
    if (!normalizedUrl) return;

    setError(null);
    setCheck({ status: 'checking' });
    let result: VersionCheckResult;
    try {
      result = await checkDaemonVersion(normalizedUrl);
    } catch {
      setCheck({ status: 'idle' });
      setError('Cannot connect. Check that the URL is reachable and the remote Daemon allows browser access.');
      return;
    }
    setCheck({ status: 'done', result });

    if (!result.compatible) {
      setError(result.reason || 'Cannot connect to a compatible Monad Daemon.');
      return;
    }

    const connection = saveRemoteDaemonConnection({
      url: normalizedUrl,
      version: result.daemonVersion
    });
    onConnected(connection);
  }

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (!checking) onOpenChange(nextOpen);
      }}
      open={open}
    >
      <DialogContent
        className="sm:max-w-[31rem]"
        showCloseButton={!checking}
      >
        <DialogHeader className="gap-2 pr-8">
          <div className="flex size-9 items-center justify-center rounded-(--radius-md) border border-border/70 bg-background/70">
            <Server className="size-4 text-muted-foreground" />
          </div>
          <DialogTitle>Connect remote Daemon</DialogTitle>
          <DialogDescription className="max-w-[32rem]">
            Add a Monad Daemon running on another machine. Monad verifies the URL before saving it to the Daemon menu.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="remote-daemon-url">Daemon URL</Label>
            <span className="text-muted-foreground text-xs">HTTP or HTTPS</span>
          </div>
          <Input
            aria-describedby="remote-daemon-url-help remote-daemon-status"
            aria-invalid={Boolean(error) || undefined}
            autoComplete="url"
            disabled={checking}
            id="remote-daemon-url"
            onChange={(event) => {
              setUrl(event.target.value);
              reset();
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void handleConnect();
            }}
            placeholder="http://192.168.1.100:52749"
            value={url}
          />
          <p
            className="text-muted-foreground text-xs"
            id="remote-daemon-url-help"
          >
            Include the protocol, host, and optional port or path. Do not include credentials or query parameters.
          </p>

          <div
            className={cn(
              'flex min-h-12 items-start gap-3 rounded-(--radius-md) border border-border/70 bg-background/55 px-3 py-2.5 text-sm',
              error && 'border-destructive/40 bg-destructive/8 text-destructive'
            )}
            id="remote-daemon-status"
            role={error ? 'alert' : 'status'}
          >
            {checking ? (
              <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />
            ) : error ? (
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
            ) : previewUrl ? (
              <LinkIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            ) : (
              <CircleCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            )}
            <div className="min-w-0 space-y-0.5">
              <p className={cn('font-medium', !error && 'text-foreground')}>
                {checking
                  ? 'Checking Daemon compatibility'
                  : error
                    ? error
                    : previewUrl
                      ? 'Ready to connect'
                      : 'Enter a remote Daemon URL'}
              </p>
              <p className={cn('break-all text-xs', error ? 'text-destructive/80' : 'text-muted-foreground')}>
                {checking
                  ? 'Monad is calling the remote health endpoint.'
                  : error
                    ? 'Fix the URL or remote Daemon access settings, then try again.'
                    : previewUrl
                      ? previewUrl
                      : 'A successful connection is saved locally for future sessions.'}
              </p>
            </div>
          </div>
        </div>

        <DialogFooter className="items-center gap-2 sm:justify-between">
          <p className="text-muted-foreground text-xs sm:max-w-[16rem]">
            You can switch back to the local Daemon from this menu.
          </p>
          <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
            <Button
              disabled={checking}
              onClick={() => onOpenChange(false)}
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={checking || !trimmedUrl}
              onClick={() => void handleConnect()}
            >
              {checking ? (
                <>
                  <Loader2 className="animate-spin" />
                  Connecting
                </>
              ) : (
                'Connect'
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DaemonMenu({
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
  const hasConnectionChoices = remoteConnections.length > 0;
  const activeConnectionMeta = daemonStatus === 'online' ? 'Connected' : daemonStatusText;
  const activeConnectionVersion = daemonStatus === 'online' ? daemonVersion : undefined;

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

  return (
    <>
      <DropdownMenu
        onOpenChange={onOpenChange}
        open={menuOpen}
      >
        <DropdownMenuTrigger asChild>
          <button
            className={cn(
              'flex min-w-0 flex-1 items-center gap-2.5 rounded-(--radius-md) px-2.5 py-2 text-left transition hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
              (showSettings || menuOpen) && 'bg-sidebar-accent text-sidebar-accent-foreground'
            )}
            type="button"
          >
            <div className="rounded-full border border-border/80 bg-background/60 p-1.5">
              <Server className="size-4" />
            </div>
            {showConnectionLabel ? (
              <span className="min-w-0 flex-1 font-normal leading-tight">
                <span className="block truncate text-ui">{activeConnection.label}</span>
                <span className="block truncate text-muted-foreground text-xs">{activeConnectionMeta}</span>
              </span>
            ) : (
              <span className="min-w-0 flex-1 font-normal text-ui leading-control">Daemon</span>
            )}
            {hasUpgrade ? <span className="ml-auto size-2 shrink-0 rounded-full bg-accent-blue" /> : null}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-[min(20rem,calc(100vw-1rem))]"
          onKeyDown={onMenuKeyDown}
          side="top"
        >
          <DropdownMenuGroup>
            <DropdownMenuLabel className="flex items-center gap-2 font-normal text-base leading-control">
              <span className="text-foreground">Daemon</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    aria-label="Connect remote Monad Daemon"
                    className="ml-auto size-7 shrink-0"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setDialogOpen(true);
                    }}
                    size="icon"
                    variant="ghost"
                  >
                    <Plus />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Connect remote Monad Daemon</TooltipContent>
              </Tooltip>
            </DropdownMenuLabel>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DaemonConnectionItem
              active={activeConnection.id === LOCAL_DAEMON_ID}
              label="Local"
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
              icon={House}
              label="Workplace"
              onClick={onOpenWorkspace}
            />
            <DaemonMenuTile
              active={studioPileActive}
              icon={SlidersHorizontal}
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
              <Settings2 className="size-4" />
              <span>{t('web.sidebar.settings')}</span>
              {hasUpgrade ? <span className="size-2 shrink-0 rounded-full bg-accent-blue" /> : null}
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

export function SessionSidebar({
  autoCollapseOnPointerLeave,
  projects,
  collapsed,
  overlay,
  hasUpgrade,
  showSettings,
  showStudio,
  studioPileActive,
  workspacePileActive,
  monadChatActive,
  activeProjectId,
  daemonBaseUrl,
  daemonStatus,
  daemonVersion,
  studioSection,
  shortcutModifierLabel = '⌘',
  showShortcutBadges,
  onOpenWorkspace,
  onOpenMonadChat,
  onOpenProject,
  onOpenStudioSection,
  onRequestCollapse,
  onRequestPersistentExpand,
  onSwitchDaemonConnection,
  onToggleCollapsed,
  onToggleSettings,
  onToggleStudio
}: Props) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [resizing, setResizing] = useState(false);
  const dragStartRef = useRef({ pointerX: 0, width: DEFAULT_SIDEBAR_WIDTH });
  const suppressMouseResizeRef = useRef(false);

  useEffect(() => {
    const storedWidth = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (!storedWidth) return;
    const nextWidth = Number.parseInt(storedWidth, 10);
    if (Number.isFinite(nextWidth)) setSidebarWidth(clampSidebarWidth(nextWidth));
  }, []);

  const openMenuAction = (action: () => void) => {
    setMenuOpen(false);
    action();
  };

  const onDaemonMenuOpenChange = useCallback(
    (open: boolean) => {
      setMenuOpen(open);
      if (open && autoCollapseOnPointerLeave) onRequestPersistentExpand?.();
    },
    [autoCollapseOnPointerLeave, onRequestPersistentExpand]
  );

  const setMeasuredSidebarWidth = useCallback((width: number) => {
    const nextWidth = clampSidebarWidth(width);
    setSidebarWidth(nextWidth);
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(nextWidth));
  }, []);

  const beginResize = useCallback(
    ({
      cancelEvent,
      clientX,
      moveEvent,
      upEvent
    }: {
      cancelEvent?: 'pointercancel';
      clientX: number;
      moveEvent: 'mousemove' | 'pointermove';
      upEvent: 'mouseup' | 'pointerup';
    }) => {
      dragStartRef.current = { pointerX: clientX, width: sidebarWidth };
      setResizing(true);

      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.documentElement.dataset.sidebarResizing = 'true';

      const onResizeMove = (resizeEvent: MouseEvent | PointerEvent) => {
        setMeasuredSidebarWidth(dragStartRef.current.width + resizeEvent.clientX - dragStartRef.current.pointerX);
      };
      const onResizeEnd = () => {
        setResizing(false);
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        delete document.documentElement.dataset.sidebarResizing;
        window.removeEventListener(moveEvent, onResizeMove);
        window.removeEventListener(upEvent, onResizeEnd);
        if (cancelEvent) window.removeEventListener(cancelEvent, onResizeEnd);
      };

      window.addEventListener(moveEvent, onResizeMove);
      window.addEventListener(upEvent, onResizeEnd);
      if (cancelEvent) window.addEventListener(cancelEvent, onResizeEnd);
    },
    [setMeasuredSidebarWidth, sidebarWidth]
  );

  const onResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLHRElement>) => {
      event.preventDefault();
      suppressMouseResizeRef.current = true;
      window.setTimeout(() => {
        suppressMouseResizeRef.current = false;
      }, 0);
      beginResize({
        cancelEvent: 'pointercancel',
        clientX: event.clientX,
        moveEvent: 'pointermove',
        upEvent: 'pointerup'
      });
    },
    [beginResize]
  );

  const onResizeMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLHRElement>) => {
      if (event.button !== 0 || suppressMouseResizeRef.current) return;
      event.preventDefault();
      beginResize({ clientX: event.clientX, moveEvent: 'mousemove', upEvent: 'mouseup' });
    },
    [beginResize]
  );

  const onResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLHRElement>) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End')
        return;
      event.preventDefault();
      if (event.key === 'Home') setMeasuredSidebarWidth(MIN_SIDEBAR_WIDTH);
      else if (event.key === 'End') setMeasuredSidebarWidth(MAX_SIDEBAR_WIDTH);
      else setMeasuredSidebarWidth(sidebarWidth + (event.key === 'ArrowRight' ? 12 : -12));
    },
    [setMeasuredSidebarWidth, sidebarWidth]
  );

  const expandedStyle = { width: sidebarWidth } satisfies CSSProperties;
  const daemonStatusText =
    daemonStatus === 'online'
      ? t('web.sidebar.daemonOnline')
      : daemonStatus === 'offline'
        ? t('web.sidebar.daemonOffline')
        : t('web.sidebar.daemonChecking');
  const daemonStatusClass =
    daemonStatus === 'online' ? 'bg-success' : daemonStatus === 'offline' ? 'bg-destructive' : 'bg-muted-foreground';

  return (
    <aside
      className={cn(
        'panel-nav group/sidebar hidden h-full min-h-0 flex-col overflow-hidden text-sidebar-foreground md:flex',
        (collapsed || overlay) && 'panel-nav-overlay',
        resizing ? 'transition-none' : 'transition-[width,opacity,transform] duration-200 ease-out',
        overlay && !collapsed && 'translate-x-0 opacity-100',
        collapsed && 'pointer-events-none -translate-x-[calc(100%-12px)] opacity-0'
      )}
      data-resizing={resizing}
      onPointerLeave={() => {
        if (autoCollapseOnPointerLeave && !menuOpen) onRequestCollapse?.();
      }}
      style={expandedStyle}
    >
      <div
        className="flex h-full min-h-0 flex-col"
        style={expandedStyle}
      >
        <SidebarHeader
          onOpenWorkspace={onOpenWorkspace}
          onToggleCollapsed={onToggleCollapsed}
          t={t}
        />

        <div
          className="panel-nav-mode flex min-h-0 flex-1 flex-col"
          data-mode={showStudio ? 'studio' : 'workspace'}
          key={showStudio ? 'studio' : 'workspace'}
        >
          {showStudio ? (
            <StudioSidebarItems
              activeSection={studioSection}
              onSelect={onOpenStudioSection}
              shortcutModifierLabel={shortcutModifierLabel}
              showShortcutBadges={showShortcutBadges}
              t={t}
            />
          ) : (
            <WorkspaceSidebarItems
              activeProjectId={activeProjectId}
              monadChatActive={monadChatActive}
              onOpenMonadChat={onOpenMonadChat}
              onOpenProject={onOpenProject}
              projects={projects}
              t={t}
            />
          )}
        </div>

        <div className="relative flex items-center gap-1 px-2.5 py-2">
          <DaemonMenu
            daemonBaseUrl={daemonBaseUrl}
            daemonStatus={daemonStatus}
            daemonStatusClass={daemonStatusClass}
            daemonStatusText={daemonStatusText}
            daemonVersion={daemonStatus === 'online' ? daemonVersion : undefined}
            hasUpgrade={hasUpgrade}
            menuOpen={menuOpen}
            onOpenChange={onDaemonMenuOpenChange}
            onOpenWorkspace={() => openMenuAction(onOpenWorkspace)}
            onSwitchDaemonConnection={onSwitchDaemonConnection}
            onToggleSettings={() => openMenuAction(onToggleSettings)}
            onToggleStudio={() => openMenuAction(onToggleStudio)}
            shortcutModifierLabel={shortcutModifierLabel}
            showSettings={showSettings}
            studioPileActive={studioPileActive}
            t={t}
            workspacePileActive={workspacePileActive}
          />
          <ThemeToggle />
        </div>
      </div>
      <hr
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        aria-valuemax={MAX_SIDEBAR_WIDTH}
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuenow={sidebarWidth}
        className="panel-nav-resize-handle"
        data-preserve-cursor="true"
        onKeyDown={onResizeKeyDown}
        onMouseDown={onResizeMouseDown}
        onPointerDown={onResizePointerDown}
        tabIndex={0}
      />
    </aside>
  );
}
