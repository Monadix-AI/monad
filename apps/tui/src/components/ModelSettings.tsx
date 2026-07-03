import type { CredentialView, ProfileView } from '@monad/protocol';

import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useCallback, useMemo, useState } from 'react';

import {
  useCredentialActions,
  useCredentialsMap,
  useModelSettings,
  useModelSettingsQueryState
} from '../hooks/use-model-settings.ts';
import { t } from '../lib/i18n.ts';
import { useUIStore } from '../store/ui.ts';
import { TUI_THEME } from './theme.ts';

type Row =
  | { kind: 'provider'; providerId: string }
  | { kind: 'cred'; providerId: string; cred: CredentialView }
  | { kind: 'add-cred'; providerId: string }
  | { kind: 'profile'; profile: ProfileView };

const statusColor = (s: CredentialView['lastStatus']) =>
  s === 'ok' ? TUI_THEME.glow : s === 'error' ? TUI_THEME.danger : TUI_THEME.dim;

function toErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}

export function ModelSettings() {
  const setOverlay = useUIStore((s) => s.setOverlay);

  const settings = useModelSettings();
  const settingsQuery = useModelSettingsQueryState();
  const { providers, profiles, defaultAlias } = settings;
  const { isLoading: loading, error } = settingsQuery;
  const errorMessage = error ? toErrorMessage(error) : null;
  const credentials = useCredentialsMap(useMemo(() => providers.map((p) => p.id), [providers]));
  const credActions = useCredentialActions();

  const [cursor, setCursor] = useState(0);
  const [status, setStatus] = useState<string>('');
  const [adding, setAdding] = useState<{ providerId: string; step: 'label' | 'token'; label: string } | null>(null);
  const [field, setField] = useState('');

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const u of providers) {
      out.push({ kind: 'provider', providerId: u.id });
      for (const c of credentials[u.id] ?? []) out.push({ kind: 'cred', providerId: u.id, cred: c });
      out.push({ kind: 'add-cred', providerId: u.id });
    }
    for (const p of profiles) out.push({ kind: 'profile', profile: p });
    return out;
  }, [providers, credentials, profiles]);

  const clampedCursor = Math.min(cursor, Math.max(0, rows.length - 1));
  const current = rows[clampedCursor];

  useInput((input, key) => {
    // While the add-credential text field is focused, only Esc (cancel) is ours;
    // TextInput owns the rest.
    if (adding) {
      if (key.escape) {
        setAdding(null);
        setField('');
      }
      return;
    }

    if (key.escape) {
      setOverlay('none');
    } else if (key.upArrow) {
      setCursor((c) => Math.max(0, c - 1));
    } else if (key.downArrow) {
      setCursor((c) => Math.min(rows.length - 1, c + 1));
    } else if (input === 'r') {
      settingsQuery.refetch();
    } else if (!current) {
      // nothing selected
    } else if (input === 'd' && current.kind === 'profile') {
      const alias = current.profile.alias;
      settings
        .setDefaultProfile(alias)
        .then(() => setStatus(t('cli.tui.model.defaultSet', { alias })))
        .catch((e: unknown) => setStatus(toErrorMessage(e)));
    } else if (input === 'x' && current.kind === 'cred') {
      const { cred } = current;
      credActions
        .deleteCredential(current.providerId, cred.id)
        .then(() => setStatus(t('cli.tui.model.deleted', { label: cred.label })))
        .catch((e: unknown) => setStatus(toErrorMessage(e)));
    } else if (input === 't' && current.kind === 'cred') {
      const { cred } = current;
      setStatus(t('cli.tui.model.testing', { label: cred.label }));
      credActions
        .testCredential(current.providerId, cred.id)
        .then((r) =>
          setStatus(
            r.ok
              ? t('cli.tui.model.testOk', { label: cred.label, ms: r.latencyMs ?? '?' })
              : t('cli.tui.model.testFailed', { error: r.error ?? t('cli.failed') })
          )
        )
        .catch((e: unknown) => setStatus(toErrorMessage(e)));
    } else if ((key.return || input === 'a') && current.kind === 'add-cred') {
      setAdding({ providerId: current.providerId, step: 'label', label: '' });
      setField('');
    }
  });

  const submitField = useCallback(
    (value: string) => {
      if (!adding) return;
      if (adding.step === 'label') {
        setAdding({ ...adding, step: 'token', label: value || t('cli.tui.model.apiKeyLabel') });
        setField('');
        return;
      }
      const { providerId, label } = adding;
      const token = value;
      setAdding(null);
      setField('');
      if (!token) return;
      credActions
        .addCredential(providerId, label, token)
        .then(() => setStatus(t('cli.tui.model.added', { label })))
        .catch((e: unknown) => setStatus(toErrorMessage(e)));
    },
    [adding, credActions]
  );

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      paddingX={2}
      paddingY={1}
    >
      <Text
        bold
        color={TUI_THEME.glow}
      >
        {t('cli.tui.model.title')}
      </Text>

      {errorMessage && <Text color={TUI_THEME.danger}>{errorMessage}</Text>}

      <Box
        flexDirection="column"
        marginTop={1}
      >
        {loading && rows.length === 0 ? (
          <Text color={TUI_THEME.dim}>{t('cli.tui.loading')}</Text>
        ) : (
          rows.map((row, i) => (
            <RowView
              defaultAlias={defaultAlias}
              key={rowKey(row, i)}
              row={row}
              selected={i === clampedCursor}
            />
          ))
        )}
      </Box>

      {adding && (
        <Box marginTop={1}>
          <Text color={TUI_THEME.accent}>
            {adding.step === 'label' ? t('cli.tui.model.labelPrompt') : t('cli.tui.model.apiKeyPrompt')}
          </Text>
          <TextInput
            mask={adding.step === 'token' ? '*' : undefined}
            onChange={setField}
            onSubmit={submitField}
            placeholder={
              adding.step === 'label' ? t('cli.tui.model.labelPlaceholder') : t('cli.tui.model.apiKeyPlaceholder')
            }
            value={field}
          />
        </Box>
      )}

      {status && (
        <Box marginTop={1}>
          <Text color={TUI_THEME.dim}>{status}</Text>
        </Box>
      )}
    </Box>
  );
}

function rowKey(row: Row, i: number): string {
  if (row.kind === 'cred') return `cred:${row.cred.id}`;
  if (row.kind === 'provider') return `up:${row.providerId}`;
  if (row.kind === 'add-cred') return `add:${row.providerId}`;
  return `prof:${row.profile.alias}:${i}`;
}

function RowView({ row, selected, defaultAlias }: { row: Row; selected: boolean; defaultAlias: string }) {
  const caret = <Text color={selected ? TUI_THEME.accent : TUI_THEME.dim}>{selected ? '> ' : '  '}</Text>;

  if (row.kind === 'provider') {
    return (
      <Box marginTop={1}>
        {caret}
        <Text
          bold
          color={TUI_THEME.glow}
        >
          {t('cli.tui.model.providerPrefix', { id: row.providerId })}
        </Text>
      </Box>
    );
  }

  if (row.kind === 'cred') {
    const c = row.cred;
    return (
      <Box>
        {caret}
        <Text color={statusColor(c.lastStatus)}>● </Text>
        <Text color={selected ? TUI_THEME.accent : undefined}>{c.label}</Text>
        <Text color={TUI_THEME.dim}>
          {'  '}
          {c.accessTokenPreview ?? ''} · {t('cli.tui.model.requestCount', { count: c.requestCount })}
        </Text>
      </Box>
    );
  }

  if (row.kind === 'add-cred') {
    return (
      <Box>
        {caret}
        <Text color={selected ? TUI_THEME.accent : TUI_THEME.glow}>{t('cli.tui.model.addCredential')}</Text>
      </Box>
    );
  }

  const p = row.profile;
  const isDefault = p.alias === defaultAlias;
  return (
    <Box marginTop={row.kind === 'profile' ? 0 : 1}>
      {caret}
      <Text color={selected ? TUI_THEME.accent : undefined}>{p.alias}</Text>
      <Text color={TUI_THEME.dim}>
        {'  '}
        {p.routes.chat.provider}:{p.routes.chat.modelId}
      </Text>
      {isDefault && (
        <Text color={TUI_THEME.glow}>
          {'  '}
          {t('cli.tui.model.defaultBadge')}
        </Text>
      )}
    </Box>
  );
}
