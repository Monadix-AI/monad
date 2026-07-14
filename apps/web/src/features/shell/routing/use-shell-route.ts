import type { SessionId } from '@monad/protocol';
import type { SettingsSectionId } from '#/features/settings/sections';
import type { StudioSectionId } from '#/features/studio/sections';

import { useMemo } from 'react';

import { useShellPathname } from '#/hooks/use-shell-location';
import {
  isInboxPath,
  isProjectSettingsPath,
  isSettingsPath,
  isStudioPath,
  isWorkspacePath,
  projectIdFromPathname,
  projectSessionIdFromPathname,
  sessionIdFromPathname,
  settingsSectionFromPathname,
  studioSectionFromPathname
} from './paths';

export type ShellRoute = {
  pathname: string;
  currentId: SessionId | null;
  isStudioRoute: boolean;
  isWorkspaceRoute: boolean;
  isSettingsRoute: boolean;
  isInboxRoute: boolean;
  isProjectSettingsRoute: boolean;
  settingsSection: SettingsSectionId;
  routedStudioSection: StudioSectionId | null;
  studioSection: StudioSectionId;
  routedProjectId: string | null;
  routedProjectSessionId: SessionId | null;
};

export function useShellRoute(): ShellRoute {
  const pathname = useShellPathname();
  return useMemo(() => {
    const routedStudioSection = studioSectionFromPathname(pathname);
    return {
      pathname,
      currentId: (sessionIdFromPathname(pathname) as SessionId | null) ?? null,
      isStudioRoute: isStudioPath(pathname),
      isWorkspaceRoute: isWorkspacePath(pathname),
      isSettingsRoute: isSettingsPath(pathname),
      isInboxRoute: isInboxPath(pathname),
      isProjectSettingsRoute: isProjectSettingsPath(pathname),
      settingsSection: settingsSectionFromPathname(pathname) ?? 'connection',
      routedStudioSection,
      studioSection: routedStudioSection ?? 'runtime',
      routedProjectId: projectIdFromPathname(pathname),
      routedProjectSessionId: projectSessionIdFromPathname(pathname) as SessionId | null
    };
  }, [pathname]);
}
