import type { AtomPackUpdateCheck, NetworkSettings, SetNetworkSettingsRequest } from '@monad/protocol';
import type { NavCapability } from '../shell/capabilities.ts';

import {
  agentSelectors,
  atomPackSelectors,
  meshAgentSelectors,
  meshSessionSelectors,
  useGetNetworkQuery,
  useInitStatusQuery,
  useInstallAtomPackMutation,
  useLazyCheckAtomPackUpdateQuery,
  useListAgentsQuery,
  useListAtomPacksQuery,
  useListLiveMeshSessionsQuery,
  useListMeshAgentsQuery,
  useSetNetworkMutation,
  useUpdateAtomPackMutation
} from '@monad/client-rtk';
import { openUrl } from '@monad/environment';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
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

type AtomPackScreenMode = 'list' | 'github' | 'local' | 'install-consent' | 'update-confirm';

export function atomPackSourceSpec(kind: 'github' | 'local', input: string): string {
  const source = input.trim();
  return kind === 'local' && !source.startsWith('local:') ? `local:${source}` : source;
}

export function AtomPacksScreen({ active }: { active: boolean }) {
  const query = useListAtomPacksQuery();
  const packs = query.data ? atomPackSelectors.selectAll(query.data.atomPacks) : [];
  const [install, installState] = useInstallAtomPackMutation();
  const [checkUpdate, checkState] = useLazyCheckAtomPackUpdateQuery();
  const [update, updateState] = useUpdateAtomPackMutation();
  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<AtomPackScreenMode>('list');
  const [source, setSource] = useState('');
  const [status, setStatus] = useState('');
  const [updateCheck, setUpdateCheck] = useState<AtomPackUpdateCheck | null>(null);
  const selected = packs[Math.min(cursor, Math.max(0, packs.length - 1))];
  const busy = installState.isLoading || checkState.isFetching || updateState.isLoading;

  const reset = (message = '') => {
    setMode('list');
    setSource('');
    setUpdateCheck(null);
    setStatus(message);
  };

  const submitInstall = (consent: boolean) => {
    const input = source.trim();
    if (!input) return;
    const spec = atomPackSourceSpec(mode === 'local' ? 'local' : 'github', input);
    void install({ source: spec, consent })
      .unwrap()
      .then((result) => {
        if (result.needsConsent) {
          setSource(spec);
          setMode('install-consent');
          setStatus(t('cli.tui.atoms.consent', { atoms: result.atoms.join(', ') || 'none' }));
          return;
        }
        reset(t('cli.tui.atoms.installed', { name: result.name }));
      })
      .catch((error) => setStatus(error instanceof Error ? error.message : String(error)));
  };

  useInput(
    (input, key) => {
      if (busy) return;
      if (mode === 'github' || mode === 'local') {
        if (key.escape) reset();
        return;
      }
      if (mode === 'install-consent') {
        if (input.toLowerCase() === 'y') submitInstall(true);
        else if (input.toLowerCase() === 'n' || key.escape) reset();
        return;
      }
      if (mode === 'update-confirm') {
        if (input.toLowerCase() === 'y' && updateCheck?.hasUpdate) {
          void update({ name: updateCheck.name, revision: updateCheck.latestRevision })
            .unwrap()
            .then(() => reset(t('cli.tui.atoms.updated', { name: updateCheck.name })))
            .catch((error) => setStatus(error instanceof Error ? error.message : String(error)));
        } else if (input.toLowerCase() === 'n' || key.escape) reset();
        return;
      }
      if (key.upArrow) setCursor((value) => Math.max(0, value - 1));
      else if (key.downArrow) setCursor((value) => Math.min(Math.max(0, packs.length - 1), value + 1));
      else if (input === 'g') {
        setStatus('');
        setMode('github');
      } else if (input === 'l') {
        setStatus('');
        setMode('local');
      } else if (input === 'c' && selected?.canUpdate) {
        setStatus(t('cli.tui.atoms.checking'));
        void checkUpdate(selected.name)
          .unwrap()
          .then((result) => {
            setUpdateCheck(result);
            if (result.hasUpdate) setMode('update-confirm');
            else setStatus(t('cli.tui.atoms.current', { version: result.currentVersion }));
          })
          .catch((error) => setStatus(error instanceof Error ? error.message : String(error)));
      } else if (input === 'r') query.refetch();
    },
    { isActive: active }
  );

  return (
    <Screen title={t('cli.tui.atoms.title')}>
      {packs.map((pack, index) => (
        <Text
          color={index === cursor ? TUI_THEME.accent : undefined}
          key={pack.name}
        >
          {index === cursor ? '› ' : '  '}
          {pack.displayName ?? pack.name}{' '}
          <Text color={TUI_THEME.dim}>
            v{pack.version} · {pack.sourceKind ?? 'builtin'}
          </Text>
        </Text>
      ))}
      {packs.length === 0 ? <Text color={TUI_THEME.dim}>{t('cli.tui.atoms.empty')}</Text> : null}
      {mode === 'github' || mode === 'local' ? (
        <Box>
          <Text color={TUI_THEME.dim}>
            {t(mode === 'github' ? 'cli.tui.atoms.githubPrompt' : 'cli.tui.atoms.localPrompt')}{' '}
          </Text>
          <TextInput
            onChange={setSource}
            onSubmit={() => submitInstall(false)}
            value={source}
          />
        </Box>
      ) : null}
      {mode === 'install-consent' ? <Text color={TUI_THEME.warning}>{status} · y/n</Text> : null}
      {mode === 'update-confirm' && updateCheck ? (
        <Text color={TUI_THEME.warning}>
          {t('cli.tui.atoms.updateConfirm', {
            current: updateCheck.currentVersion,
            latest: updateCheck.latestVersion,
            name: updateCheck.name
          })}{' '}
          · y/n
        </Text>
      ) : null}
      {mode === 'list' ? <Text color={TUI_THEME.dim}>{t('cli.tui.atoms.keys')}</Text> : null}
      {busy ? <Text color={TUI_THEME.warning}>{t('cli.tui.atoms.working')}</Text> : null}
      {status && mode === 'list' ? <Text color={TUI_THEME.warning}>{status}</Text> : null}
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
    'studio.atoms': 'Installed Atom Packs and Atom availability summary.',
    'studio.import': 'Settings import requires the Web validation and preview flow.',
    'settings.profile': 'Profile identity and account summary.',
    'settings.licenses': 'Open-source license inventory.',
    'settings.system': 'System diagnostics, updates and reset controls.'
  };
  return summaries[id] ?? 'This capability is represented by a terminal-safe summary.';
}
