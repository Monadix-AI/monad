import type { ComponentProps, Context } from 'react';
import type { SessionRouteModel } from '#/features/session/session-route-contract';
import type { Settings } from '#/features/settings/Settings';
import type { WorkspaceRouteProps } from '#/features/workspace/WorkspaceRoute';

import { createContext, useContext } from 'react';

export type ShellRouteContextValue = {
  onCloseStudio: () => void;
  sessionRouteModel: SessionRouteModel | null;
  settingsRouteProps: ComponentProps<typeof Settings>;
  workspaceRouteProps: WorkspaceRouteProps;
};

type ShellRouteContextGlobal = typeof globalThis & {
  __monadShellRouteContext?: Context<ShellRouteContextValue | null>;
};

const contextGlobal = globalThis as ShellRouteContextGlobal;

if (!contextGlobal.__monadShellRouteContext) {
  contextGlobal.__monadShellRouteContext = createContext<ShellRouteContextValue | null>(null);
}

export const ShellRouteContext = contextGlobal.__monadShellRouteContext;

export function useShellRouteContext(): ShellRouteContextValue {
  const value = useContext(ShellRouteContext);
  if (!value) throw new Error('useShellRouteContext must be used within ShellRouteProvider');
  return value;
}
