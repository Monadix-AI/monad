import type { NetworkSettings, SetNetworkSettingsRequest } from '@monad/protocol';
import type { NavCapability } from '../shell/capabilities.ts';

import {
  agentSelectors,
  meshAgentSelectors,
  meshSessionSelectors,
  useGetNetworkQuery,
  useInitStatusQuery,
  useListAgentsQuery,
  useListLiveMeshSessionsQuery,
  useListMeshAgentsQuery,
  useSetNetworkMutation
} from '@monad/client-rtk';
import { openUrl } from '@monad/environment';
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';

import { t } from '../lib/i18n.ts';
import { TUI_THEME } from './theme.ts';

export function RuntimeScreen({ active }: { active: boolean }) {
  const status = useInitStatusQuery();
  const runtimes = useListLiveMeshSessionsQuery({ limit: 100 });
  const rows = runtimes.data ? meshSessionSelectors.selectAll(runtimes.data.sessions) : [];
  useInput(
    (input) => {
      if (input === 'r') {
        status.refetch();
        runtimes.refetch();
      }
    },
    { isActive: active }
  );
  return (
    <Screen title="Runtime">
      <Text color={status.error ? TUI_THEME.danger : TUI_THEME.glow}>
        daemon {status.error ? 'unavailable' : status.isLoading ? 'checking' : 'online'}
      </Text>
      <Text color={TUI_THEME.dim}>live mesh-agent runtimes: {rows.length}</Text>
      {rows.map((runtime) => (
        <Text key={runtime.id}>
          · {runtime.agentName}{' '}
          <Text color={TUI_THEME.dim}>
            {runtime.provider} ·{' '}
            {runtime.lifecycle.state === 'terminal' ? runtime.lifecycle.termination.kind : runtime.lifecycle.state}
          </Text>
        </Text>
      ))}
      <Text color={TUI_THEME.dim}>r refresh</Text>
    </Screen>
  );
}

export function AgentsScreen({ active }: { active: boolean }) {
  const query = useListAgentsQuery();
  const rows = query.data ? agentSelectors.selectAll(query.data) : [];
  useInput((input) => input === 'r' && query.refetch(), { isActive: active });
  return (
    <Screen title="Monad Agents">
      {rows.map((agent) => (
        <Text key={agent.id}>
          · {agent.name} <Text color={TUI_THEME.dim}>{agent.id}</Text>
        </Text>
      ))}
      {rows.length === 0 ? <Text color={TUI_THEME.dim}>No agents configured.</Text> : null}
      <Text color={TUI_THEME.dim}>r refresh · advanced editing opens Web</Text>
    </Screen>
  );
}

export function MeshAgentsScreen({ active }: { active: boolean }) {
  const query = useListMeshAgentsQuery();
  const rows = query.data ? meshAgentSelectors.selectAll(query.data) : [];
  useInput((input) => input === 'r' && query.refetch(), { isActive: active });
  return (
    <Screen title="MeshAgents">
      {rows.map((agent) => (
        <Text key={agent.name}>
          · {agent.name} <Text color={TUI_THEME.dim}>{agent.provider}</Text>
        </Text>
      ))}
      {rows.length === 0 ? <Text color={TUI_THEME.dim}>No MeshAgents configured.</Text> : null}
      <Text color={TUI_THEME.dim}>r refresh · runtime processes appear under Runtime</Text>
    </Screen>
  );
}

export function DegradedScreen({
  active,
  baseUrl,
  capability
}: {
  active: boolean;
  baseUrl: string;
  capability: NavCapability;
}) {
  const [status, setStatus] = useState('');
  const url = `${baseUrl.replace(/\/$/, '')}${capability.path}`;
  const open = () => setStatus(openUrl(url) ? 'Opened in Web.' : `Unable to launch browser. Copy: ${url}`);
  useInput((input, key) => (input === 'o' || key.return) && open(), { isActive: active });
  return (
    <Screen title={capability.label}>
      <Text color={capability.mode === 'web-only' ? TUI_THEME.warning : TUI_THEME.accent}>
        {capability.mode === 'web-only' ? 'Web-only capability' : 'Terminal summary'}
      </Text>
      <Text>{summary(capability.id)}</Text>
      <Text color={TUI_THEME.dim}>{url}</Text>
      <Text color={TUI_THEME.dim}>Enter/o open Web</Text>
      {status ? <Text color={TUI_THEME.glow}>{status}</Text> : null}
    </Screen>
  );
}

export type ConnectionInputAction =
  | { kind: 'cancel' }
  | { kind: 'confirm' }
  | { kind: 'none' }
  | { kind: 'request'; request: SetNetworkSettingsRequest };

export function connectionInputAction(
  input: string,
  settings: NetworkSettings,
  confirmingRemoteHttp: boolean
): ConnectionInputAction {
  const key = input.toLowerCase();
  if (confirmingRemoteHttp) {
    if (key === 'y') {
      return {
        kind: 'request',
        request: { confirmInsecureRemoteAccess: true, https: { enabled: false } }
      };
    }
    if (key === 'n' || key === '\u001b') return { kind: 'cancel' };
    return { kind: 'none' };
  }
  if (key === 'h') {
    if (settings.https.enabled && settings.remoteAccess.enabled) return { kind: 'confirm' };
    return { kind: 'request', request: { https: { enabled: !settings.https.enabled } } };
  }
  return { kind: 'none' };
}

export function ConnectionScreen({ active, baseUrl }: { active: boolean; baseUrl: string }) {
  const network = useGetNetworkQuery(undefined);
  const [setNetwork, mutation] = useSetNetworkMutation();
  const [confirmingRemoteHttp, setConfirmingRemoteHttp] = useState(false);
  const [status, setStatus] = useState('');
  const settings = network.data;

  useInput(
    (input, key) => {
      if (!settings || mutation.isLoading) return;
      const action = connectionInputAction(key.escape ? '\u001b' : input, settings, confirmingRemoteHttp);
      if (action.kind === 'confirm') {
        setConfirmingRemoteHttp(true);
        return;
      }
      if (action.kind === 'cancel') {
        setConfirmingRemoteHttp(false);
        setStatus('');
        return;
      }
      if (action.kind !== 'request') return;
      setConfirmingRemoteHttp(false);
      void setNetwork(action.request)
        .unwrap()
        .then(() => setStatus(t('cli.tui.connection.saved')))
        .catch((error) => setStatus(error instanceof Error ? error.message : String(error)));
    },
    { isActive: active }
  );

  return (
    <Screen title="Connection">
      <Text color={TUI_THEME.glow}>daemon connected</Text>
      <Text>{baseUrl}</Text>
      {settings ? (
        <>
          <Text>
            {t('cli.tui.connection.httpsLabel')}{' '}
            <Text color={settings.https.enabled ? TUI_THEME.glow : TUI_THEME.warning}>
              {t(settings.https.enabled ? 'cli.enabled' : 'cli.disabled')}
            </Text>
          </Text>
          {!settings.https.enabled && settings.remoteAccess.enabled ? (
            <Text
              bold
              color={TUI_THEME.danger}
            >
              {t('cli.tui.connection.remoteHttpWarning')}
            </Text>
          ) : null}
          {confirmingRemoteHttp ? (
            <>
              <Text color={TUI_THEME.danger}>{t('cli.tui.connection.remoteHttpConfirm')}</Text>
              <Text color={TUI_THEME.warning}>{t('cli.tui.connection.confirmHint')}</Text>
            </>
          ) : (
            <Text color={TUI_THEME.dim}>{t('cli.tui.connection.keys')}</Text>
          )}
        </>
      ) : (
        <Text color={TUI_THEME.dim}>{t('cli.tui.connection.loading')}</Text>
      )}
      {status ? <Text color={TUI_THEME.warning}>{status}</Text> : null}
    </Screen>
  );
}

export function PreferencesScreen() {
  return (
    <Screen title="Terminal preferences">
      <Text>Keyboard: Kitty protocol auto-detect with portable fallbacks</Text>
      <Text>Mouse: SGR click, wheel and drag; hold Shift for native selection</Text>
      <Text>Layout: wide ≥120 · medium ≥80 · compact ≥60</Text>
      <Text color={TUI_THEME.dim}>Custom keymaps are intentionally out of scope for v1.</Text>
    </Screen>
  );
}

function Screen({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <Box
      flexDirection="column"
      paddingX={2}
      paddingY={1}
    >
      <Text
        bold
        color={TUI_THEME.glow}
      >
        {title}
      </Text>
      {children}
    </Box>
  );
}

function summary(id: string): string {
  const summaries: Record<string, string> = {
    'studio.capabilities': 'Capability inventory and availability across tools, MCP and channels.',
    'studio.acpDelegates': 'Configured ACP delegate endpoints and health.',
    'studio.memory': 'Memory backend, fact counts and graph status. Visual graph rendering is Web-only.',
    'studio.safety': 'Sandbox defaults, hooks and approval policy summary.',
    'studio.mesh': 'Agent mesh status. Topology visualization is Web-only.',
    'studio.workplaceProjects': 'Project runtime overview; text sessions are available under Workspace.',
    'studio.atoms': 'Installed atom packs and enabled state summary.',
    'studio.import': 'Settings import requires the Web validation and preview flow.',
    'settings.profile': 'Profile identity and account summary.',
    'settings.mo': 'Mo is a graphical desktop companion and is not rendered in a terminal.',
    'settings.licenses': 'Open-source license inventory.',
    'settings.system': 'System diagnostics, updates and reset controls.'
  };
  return summaries[id] ?? 'This capability is represented by a terminal-safe summary.';
}
