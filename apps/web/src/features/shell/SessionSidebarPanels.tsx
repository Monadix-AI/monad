import type { NetworkRuntimeStatus } from '@monad/protocol';
import type { ComponentProps, RefObject } from 'react';
import type { SettingsSectionId } from '#/features/settings/sections';
import type { StudioSectionId } from '#/features/studio/sections';
import type { RemoteDaemonConnection } from '#/lib/daemon-connections';
import type { TFunction } from './sidebar/types';
import type { WorkspaceSidebarContextValue } from './sidebar/workspace-sidebar-context';
import type { SidebarPagerSurface } from './sidebar-trackpad-switch';

import { motion } from 'motion/react';

import { ThemeToggle } from '#/components/ThemeToggle';
import { DaemonMenu } from './SessionSidebarDaemonMenu';
import { SettingsSidebarItems, StudioSidebarItems, WorkspaceSidebarItems } from './sidebar';
import { ArchivedSidebarItems } from './sidebar/archived-items';

type PagerStyle = ComponentProps<typeof motion.div>['style'];

interface SessionSidebarPagerConfig {
  panelScrollRef: RefObject<HTMLDivElement | null>;
  style: PagerStyle;
  surfaces: SidebarPagerSurface[];
}

interface SessionSidebarSettingsConfig {
  activeSection: SettingsSectionId;
  onBack: () => void;
  onSelect: (section: SettingsSectionId) => void;
}

interface SessionSidebarArchivedConfig {
  chatSessions: ComponentProps<typeof ArchivedSidebarItems>['chatSessions'];
  loading?: boolean;
  onBack: () => void;
  onDeleteSession: ComponentProps<typeof ArchivedSidebarItems>['onDeleteSession'];
  onOpenProjectSession: ComponentProps<typeof ArchivedSidebarItems>['onOpenProjectSession'];
  onOpenSession: ComponentProps<typeof ArchivedSidebarItems>['onOpenSession'];
  onUnarchiveSession: ComponentProps<typeof ArchivedSidebarItems>['onUnarchiveSession'];
  projectSessions: ComponentProps<typeof ArchivedSidebarItems>['projectSessions'];
}

interface SessionSidebarStudioConfig {
  activeSection: StudioSectionId;
  onSelect: (section: StudioSectionId) => void;
  runtimeReady: boolean;
  shortcutModifierLabel: string;
  showShortcutBadges?: boolean;
}

interface SessionSidebarFooterConfig {
  daemonBaseUrl: string;
  daemonStatus: 'checking' | 'online' | 'offline';
  daemonStatusClass: string;
  daemonStatusText: string;
  daemonVersion?: string;
  hasUpgrade?: boolean;
  menuOpen: boolean;
  networkRuntime?: NetworkRuntimeStatus;
  onOpenChange: (open: boolean) => void;
  onOpenStudio: () => void;
  onOpenWorkspace: () => void;
  onRunMenuAction: (action: () => void) => void;
  onSwitchDaemonConnection: (
    request: { type: 'local' } | { connection: RemoteDaemonConnection; type: 'remote' }
  ) => void;
  onToggleSettings: () => void;
  shortcutModifierLabel: string;
  showSettings: boolean;
  studioPileActive: boolean;
  workspacePileActive: boolean;
}

interface SessionSidebarPanelsProps {
  archived: SessionSidebarArchivedConfig;
  footer: SessionSidebarFooterConfig;
  pager: SessionSidebarPagerConfig;
  settings: SessionSidebarSettingsConfig;
  studio: SessionSidebarStudioConfig;
  t: TFunction;
  workspace: WorkspaceSidebarContextValue;
}

export function SessionSidebarPanels({
  archived,
  footer,
  pager,
  settings,
  studio,
  t,
  workspace
}: SessionSidebarPanelsProps) {
  return (
    <>
      <motion.div
        className="flex min-h-0 flex-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        data-sidebar-trackpad-surface="true"
        ref={pager.panelScrollRef}
        style={pager.style}
      >
        {pager.surfaces.map((surface) => (
          <div
            className="panel-nav-snap-item flex min-h-0 w-full flex-none flex-col"
            key={surface}
          >
            {surface === 'settings' ? (
              <SettingsSidebarItems
                activeSection={settings.activeSection}
                onBack={settings.onBack}
                onSelect={settings.onSelect}
                t={t}
              />
            ) : surface === 'studio' ? (
              <StudioSidebarItems
                activeSection={studio.activeSection}
                onSelect={studio.onSelect}
                runtimeReady={studio.runtimeReady}
                shortcutModifierLabel={studio.shortcutModifierLabel}
                showShortcutBadges={studio.showShortcutBadges}
                t={t}
              />
            ) : surface === 'archived' ? (
              <ArchivedSidebarItems
                chatSessions={archived.chatSessions}
                loading={archived.loading}
                onBack={archived.onBack}
                onDeleteSession={archived.onDeleteSession}
                onOpenProjectSession={archived.onOpenProjectSession}
                onOpenSession={archived.onOpenSession}
                onUnarchiveSession={archived.onUnarchiveSession}
                projectSessions={archived.projectSessions}
                t={t}
              />
            ) : (
              <WorkspaceSidebarItems value={workspace} />
            )}
          </div>
        ))}
      </motion.div>
      <div className="relative flex items-center gap-1 px-2.5 py-2">
        <DaemonMenu
          daemonBaseUrl={footer.daemonBaseUrl}
          daemonStatus={footer.daemonStatus}
          daemonStatusClass={footer.daemonStatusClass}
          daemonStatusText={footer.daemonStatusText}
          daemonVersion={footer.daemonStatus === 'online' ? footer.daemonVersion : undefined}
          hasUpgrade={footer.hasUpgrade}
          menuOpen={footer.menuOpen}
          networkRuntime={footer.networkRuntime}
          onOpenChange={footer.onOpenChange}
          onOpenStudio={() => footer.onRunMenuAction(footer.onOpenStudio)}
          onOpenWorkspace={() => footer.onRunMenuAction(footer.onOpenWorkspace)}
          onSwitchDaemonConnection={footer.onSwitchDaemonConnection}
          onToggleSettings={() => footer.onRunMenuAction(footer.onToggleSettings)}
          shortcutModifierLabel={footer.shortcutModifierLabel}
          showSettings={footer.showSettings}
          studioPileActive={footer.studioPileActive}
          t={t}
          workspacePileActive={footer.workspacePileActive}
        />
        <ThemeToggle />
      </div>
    </>
  );
}
