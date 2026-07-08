'use client';

import {
  Alert01Icon,
  CheckIcon,
  Copy01Icon,
  Delete02Icon,
  FileCodeIcon,
  GlobeIcon,
  LoaderPinwheelIcon,
  PowerIcon,
  RotateLeft01Icon,
  SquareArrowUp01Icon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  useDeleteSessionMutation,
  useGetDeveloperQuery,
  useGetHealthQuery,
  useGetStartupQuery,
  useGetSystemUpgradeQuery,
  useListSessionsQuery,
  useProbeNetworkMutation,
  useResetUsageMutation,
  useSetDeveloperMutation,
  useSetStartupMutation,
  useStartSystemUpgradeMutation
} from '@monad/client-rtk';
import { Badge, Button, Input, Label, ScrollArea, Separator, Switch } from '@monad/ui';
import { useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { useNetworkSettings } from '@/hooks/use-network-settings';
import { resolveConnection, watchUpgradeRestartAndReload } from '@/lib/monad-store';
import { SECRET_INPUT_PASSWORD_MANAGER_PROPS } from '@/lib/secret-input-props';
import { SettingsBreadcrumbHeader } from './SettingsBreadcrumbHeader';

interface Props {
  onClose: () => void;
}

export function SystemSettings({ onClose }: Props) {
  const t = useT();
  const { data: health, isLoading } = useGetHealthQuery();
  const [resetUsage, { isLoading: isResettingUsage }] = useResetUsageMutation();
  const { data: developer } = useGetDeveloperQuery();
  const [setDeveloper, { isLoading: isSavingDeveloper }] = useSetDeveloperMutation();
  const {
    data: startup,
    isFetching: isFetchingStartup,
    refetch: refetchStartup
  } = useGetStartupQuery(undefined, {
    refetchOnMountOrArgChange: true
  });
  const [setStartup, { isLoading: isSavingStartup }] = useSetStartupMutation();
  const network = useNetworkSettings();
  const [usageResetDone, setUsageResetDone] = useState(false);
  const [networkCopied, setNetworkCopied] = useState(false);
  const [probeResults, setProbeResults] = useState<
    Record<string, { error?: string; latencyMs?: number; ok: boolean; status?: number }>
  >({});
  const [probeNetwork, { isLoading: isProbingNetwork }] = useProbeNetworkMutation();
  const { data: sessionData } = useListSessionsQuery(undefined);
  const sessionIds = Object.keys(sessionData?.sessions?.entities ?? {});
  const sessionCount = sessionIds.length;
  const [deleteSession] = useDeleteSessionMutation();
  const [clearingAllSessions, setClearingAllSessions] = useState(false);
  const [sessionsCleared, setSessionsCleared] = useState(false);

  const version = health?.version ?? '—';
  const latestVersion = (health as { latestVersion?: string } | undefined)?.latestVersion;
  const hasUpgrade = latestVersion && latestVersion !== version;
  const { data: upgradeStatus } = useGetSystemUpgradeQuery(undefined, {
    pollingInterval: upgradeStatusIsActive((health as { latestVersion?: string } | undefined)?.latestVersion, version)
      ? 1000
      : 0
  });
  const [startSystemUpgrade, { isLoading: isStartingUpgrade }] = useStartSystemUpgradeMutation();
  const upgradeStage = upgradeStatus?.stage ?? 'idle';
  const upgradeActive =
    upgradeStage === 'checking' ||
    upgradeStage === 'downloading' ||
    upgradeStage === 'verifying' ||
    upgradeStage === 'installing' ||
    upgradeStage === 'restarting';
  const upgradeProgress = upgradeStatus?.progress ?? 0;

  async function handleClearAllSessions() {
    if (sessionIds.length === 0) return;
    setClearingAllSessions(true);
    try {
      await Promise.all(sessionIds.map((id) => deleteSession(id as Parameters<typeof deleteSession>[0])));
      setSessionsCleared(true);
      setTimeout(() => setSessionsCleared(false), 3000);
    } finally {
      setClearingAllSessions(false);
    }
  }

  async function handleResetUsage() {
    await resetUsage();
    setUsageResetDone(true);
    setTimeout(() => setUsageResetDone(false), 3000);
  }

  async function handleDeveloperMode(enabled: boolean) {
    await setDeveloper({ developerMode: enabled }).unwrap();
  }

  async function handleStartup(enabled: boolean) {
    await setStartup({ enabled }).unwrap();
  }

  async function toggleRemoteAccess(enabled: boolean) {
    await network.set({ remoteAccess: { enabled } });
  }

  async function toggleHttps(enabled: boolean) {
    await network.set({ https: { enabled } });
  }

  async function toggleLocalHttpFallback(enabled: boolean) {
    await network.set({ localHttpFallback: { enabled } });
  }

  async function updateNetworkHost(value: string) {
    const host = value.trim();
    if (!host || host === network.settings?.host) return;
    await network.set({ host });
  }

  async function rotateRemoteToken() {
    await network.set({ remoteAccess: { rotateToken: true } });
    setNetworkCopied(false);
  }

  async function copyRemoteToken() {
    const remoteToken = network.settings?.remoteAccess?.token;
    if (!remoteToken) return;
    await navigator.clipboard.writeText(remoteToken);
    setNetworkCopied(true);
    setTimeout(() => setNetworkCopied(false), 1500);
  }

  async function checkRemoteUrl(url: string) {
    const result = await probeNetwork({ url, token: network.settings?.remoteAccess.token ?? undefined }).unwrap();
    setProbeResults((current) => ({ ...current, [url]: result }));
  }

  async function handleUpgrade() {
    watchUpgradeRestartAndReload({
      baseUrl: resolveConnection().baseUrl,
      currentVersion: version,
      targetVersion: upgradeStatus?.latestVersion ?? latestVersion
    });
    await startSystemUpgrade().unwrap();
  }

  const daemonScheme = network.settings?.https.enabled === false ? 'http' : 'https';
  const httpsDisabled = network.settings?.https.enabled === false;
  const remoteHttpExposed = httpsDisabled && network.settings?.remoteAccess.enabled === true;
  const daemonHost = network.settings?.host ?? '127.0.0.1';

  return (
    <ScrollArea className="h-full">
      <div className="flex min-h-full flex-col">
        <SettingsBreadcrumbHeader
          icon={
            <HugeiconsIcon
              className="size-4"
              icon={RotateLeft01Icon}
            />
          }
          onClose={onClose}
          title={t('web.settings.system')}
        />

        <div className="flex flex-col gap-6 p-6">
          {/* Version & upgrade */}
          <section className="flex flex-col gap-3">
            <h3 className="font-semibold text-sm">{t('web.settings.system.version')}</h3>
            <div className="flex items-center gap-3">
              {isLoading ? (
                <HugeiconsIcon
                  className="size-4 animate-spin text-muted-foreground"
                  icon={LoaderPinwheelIcon}
                />
              ) : (
                <>
                  <span className="font-mono text-sm">{version}</span>
                  {hasUpgrade ? (
                    <Badge
                      className="gap-1 text-xs"
                      variant="outline"
                    >
                      <HugeiconsIcon
                        className="size-3"
                        icon={SquareArrowUp01Icon}
                      />
                      {t('web.settings.system.updateAvailable', { version: latestVersion })}
                    </Badge>
                  ) : (
                    <Badge
                      className="gap-1 text-xs"
                      variant="secondary"
                    >
                      <HugeiconsIcon
                        className="size-3"
                        icon={CheckIcon}
                      />
                      {t('web.settings.system.upToDate')}
                    </Badge>
                  )}
                </>
              )}
            </div>
            {hasUpgrade && (
              <div className="flex flex-col gap-2 rounded-md border px-3 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm">{t('web.settings.system.updateTitle')}</span>
                    <span className="text-muted-foreground text-xs">
                      {t('web.settings.system.updateDesc', { version: latestVersion })}
                    </span>
                  </div>
                  <Button
                    className="gap-1.5"
                    disabled={isStartingUpgrade || upgradeActive}
                    onClick={handleUpgrade}
                    size="sm"
                    variant="default"
                  >
                    {isStartingUpgrade || upgradeActive ? (
                      <HugeiconsIcon
                        className="size-3.5 animate-spin"
                        icon={LoaderPinwheelIcon}
                      />
                    ) : (
                      <HugeiconsIcon
                        className="size-3.5"
                        icon={SquareArrowUp01Icon}
                      />
                    )}
                    {t('web.settings.system.updateButton')}
                  </Button>
                </div>
                {upgradeStage !== 'idle' ? (
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <span className={upgradeStage === 'failed' ? 'text-destructive' : 'text-muted-foreground'}>
                      {upgradeStatus?.error ?? upgradeStageLabel(t, upgradeStage)}
                    </span>
                    <span className="font-mono text-muted-foreground">{Math.round(upgradeProgress)}%</span>
                  </div>
                ) : null}
              </div>
            )}
          </section>

          <Separator />

          <section className="flex flex-col gap-3">
            <h3 className="font-semibold text-sm">{t('web.settings.system.network')}</h3>
            <div className="grid gap-2 text-xs sm:grid-cols-2">
              <div className="rounded-md border px-3 py-2.5">
                <div className="text-muted-foreground">{t('web.conn.localEndpoint')}</div>
                <code className="font-mono text-foreground">
                  {daemonScheme}://{daemonHost}:{network.settings?.port ?? 52749}
                </code>
              </div>
              <div className="rounded-md border px-3 py-2.5">
                <div className="text-muted-foreground">{t('web.settings.system.localHttpEndpoint')}</div>
                <code className="font-mono text-foreground">
                  http://127.0.0.1:{network.settings?.localHttpFallback.port ?? 52780}
                </code>
              </div>
            </div>

            <div className="grid items-end gap-2 rounded-md border px-3 py-2.5 sm:grid-cols-[1fr_180px]">
              <div className="flex min-w-0 flex-col gap-0.5">
                <Label
                  className="text-sm"
                  htmlFor="daemon-bind-host"
                >
                  {t('web.settings.system.host')}
                </Label>
                <span className="text-muted-foreground text-xs">{t('web.settings.system.hostDesc')}</span>
              </div>
              <Input
                className="font-mono text-xs"
                defaultValue={network.settings?.host ?? '127.0.0.1'}
                disabled={network.loading || network.saving}
                id="daemon-bind-host"
                key={network.settings?.host ?? '127.0.0.1'}
                onBlur={(event) => void updateNetworkHost(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.currentTarget.blur();
                  }
                }}
              />
            </div>

            <div className="flex items-center justify-between gap-4 rounded-md border px-3 py-2.5">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm">{t('web.settings.system.https')}</span>
                <span className="text-muted-foreground text-xs">{t('web.settings.system.httpsDesc')}</span>
              </div>
              <Switch
                aria-label={t('web.settings.system.https')}
                checked={network.settings?.https.enabled !== false}
                disabled={network.loading || network.saving}
                onCheckedChange={(checked) => void toggleHttps(checked)}
              />
            </div>

            {httpsDisabled ? (
              <div className="flex items-start gap-2 rounded border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-destructive text-xs">
                <HugeiconsIcon
                  className="mt-0.5 size-3.5 shrink-0"
                  icon={Alert01Icon}
                />
                <span>{t('web.settings.system.httpsDisabledWarning')}</span>
              </div>
            ) : null}

            {remoteHttpExposed ? (
              <div className="flex items-start gap-2 rounded border border-destructive bg-destructive/10 px-2.5 py-2 font-medium text-destructive text-xs">
                <HugeiconsIcon
                  className="mt-0.5 size-3.5 shrink-0"
                  icon={Alert01Icon}
                />
                <span>{t('web.settings.system.remoteHttpWarning')}</span>
              </div>
            ) : null}

            <div className="flex items-center justify-between gap-4 rounded-md border px-3 py-2.5">
              <div className="flex min-w-0 items-start gap-2">
                <HugeiconsIcon
                  className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                  icon={GlobeIcon}
                />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm">{t('web.conn.localRemoteTitle')}</span>
                  <span className="text-muted-foreground text-xs">{t('web.conn.localRemoteDesc')}</span>
                </div>
              </div>
              <Switch
                aria-label={t('web.conn.localRemoteTitle')}
                checked={network.settings?.remoteAccess.enabled === true}
                disabled={network.loading || network.saving}
                onCheckedChange={(checked) => void toggleRemoteAccess(checked)}
              />
            </div>

            {network.settings?.remoteAccess.enabled && (
              <div className="flex flex-col gap-2 rounded-md border px-3 py-2.5">
                <Label
                  className="text-xs"
                  htmlFor="local-remote-token"
                >
                  {t('web.conn.localRemoteToken')}
                </Label>
                <div className="flex gap-2">
                  <Input
                    className="font-mono text-xs [-webkit-text-security:disc]"
                    id="local-remote-token"
                    readOnly
                    value={network.settings.remoteAccess.token ?? ''}
                    {...SECRET_INPUT_PASSWORD_MANAGER_PROPS}
                  />
                  <Button
                    aria-label={t('web.conn.copyToken')}
                    disabled={!network.settings.remoteAccess.token}
                    onClick={() => void copyRemoteToken()}
                    size="icon"
                    variant="outline"
                  >
                    <HugeiconsIcon
                      className={networkCopied ? 'text-success' : undefined}
                      icon={Copy01Icon}
                    />
                  </Button>
                  <Button
                    aria-label={t('web.conn.rotateToken')}
                    disabled={network.saving}
                    onClick={() => void rotateRemoteToken()}
                    size="icon"
                    variant="outline"
                  >
                    <HugeiconsIcon icon={RotateLeft01Icon} />
                  </Button>
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {t('web.settings.system.remoteTokenRevision', {
                    revision: network.settings.runtime?.remoteAccess.tokenRevision ?? 0
                  })}
                </div>
                {network.settings.remoteUrls.length > 0 ? (
                  <div className="flex flex-col gap-1.5 pt-1">
                    {network.settings.remoteUrls.map((entry) => {
                      const result = probeResults[entry.url];
                      return (
                        <div
                          className="grid items-center gap-2 rounded border bg-muted/20 px-2 py-1.5 text-xs sm:grid-cols-[72px_1fr_auto]"
                          key={entry.url}
                        >
                          <span className="text-muted-foreground">{entry.label}</span>
                          <code className="truncate font-mono">{entry.url}</code>
                          <div className="flex items-center justify-end gap-2">
                            {result ? (
                              <span className={result.ok ? 'text-success' : 'text-destructive'}>
                                {result.ok
                                  ? t('web.settings.system.remoteProbeOk', { ms: result.latencyMs ?? 0 })
                                  : t('web.settings.system.remoteProbeFailed')}
                              </span>
                            ) : null}
                            <Button
                              disabled={isProbingNetwork}
                              onClick={() => void checkRemoteUrl(entry.url)}
                              size="sm"
                              variant="outline"
                            >
                              {t('web.settings.system.remoteProbe')}
                            </Button>
                          </div>
                          {result?.error ? (
                            <span className="break-all text-[11px] text-destructive sm:col-span-3">{result.error}</span>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="text-muted-foreground text-xs">{t('web.settings.system.remoteUrlsEmpty')}</div>
                )}
              </div>
            )}

            <div className="flex items-center justify-between gap-4 rounded-md border px-3 py-2.5">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm">{t('web.settings.system.localHttpFallback')}</span>
                <span className="text-muted-foreground text-xs">{t('web.settings.system.localHttpFallbackDesc')}</span>
              </div>
              <Switch
                aria-label={t('web.settings.system.localHttpFallback')}
                checked={network.settings?.localHttpFallback.enabled === true}
                disabled={network.loading || network.saving}
                onCheckedChange={(checked) => void toggleLocalHttpFallback(checked)}
              />
            </div>

            {health?.certStatus || health?.certExpiry || health?.certFingerprint ? (
              <div className="flex flex-col gap-1 rounded-md border bg-muted/30 px-3 py-2.5 text-xs">
                {health.certStatus ? (
                  <span>
                    {t('web.settings.system.certStatus')}:{' '}
                    <code>{t(`web.settings.system.certStatus.${health.certStatus}`)}</code>
                  </span>
                ) : null}
                {health.certExpiry ? (
                  <span>
                    {t('web.settings.system.certExpiry')}: <code>{health.certExpiry}</code>
                  </span>
                ) : null}
                {health.certFingerprint ? (
                  <span className="break-all">
                    {t('web.conn.certFpLabel')}: <code>{health.certFingerprint}</code>
                  </span>
                ) : null}
              </div>
            ) : null}

            {network.settings?.restartRequired && (
              <div className="flex items-start gap-2 rounded border border-warning/30 bg-warning/5 px-2.5 py-2 text-warning text-xs">
                <HugeiconsIcon
                  className="mt-0.5 size-3.5 shrink-0"
                  icon={Alert01Icon}
                />
                <span>{t('web.conn.restartRequired')}</span>
              </div>
            )}
            {network.error && <div className="text-destructive text-xs">{network.error}</div>}
          </section>

          <Separator />

          <section className="flex flex-col gap-3">
            <h3 className="font-semibold text-sm">{t('web.settings.system.developer')}</h3>
            <div className="flex items-center justify-between gap-4 rounded-md border px-3 py-2.5">
              <div className="flex min-w-0 items-start gap-2">
                <HugeiconsIcon
                  className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                  icon={FileCodeIcon}
                />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm">{t('web.settings.system.developerMode')}</span>
                  <span className="text-muted-foreground text-xs">{t('web.settings.system.developerModeDesc')}</span>
                  {developer?.logsDir ? (
                    <code className="mt-1 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                      {developer.logsDir}
                    </code>
                  ) : null}
                </div>
              </div>
              <Switch
                aria-label={t('web.settings.system.developerMode')}
                checked={developer?.developerMode === true}
                disabled={isSavingDeveloper}
                onCheckedChange={handleDeveloperMode}
              />
            </div>
          </section>

          <Separator />

          <section className="flex flex-col gap-3">
            <h3 className="font-semibold text-sm">{t('web.settings.system.startup')}</h3>
            <div className="flex items-center justify-between gap-4 rounded-md border px-3 py-2.5">
              <div className="flex min-w-0 items-start gap-2">
                <HugeiconsIcon
                  className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                  icon={PowerIcon}
                />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm">{t('web.settings.system.launchAtLogin')}</span>
                  <span className="text-muted-foreground text-xs">
                    {startup?.supported === false
                      ? t('web.settings.system.launchAtLoginUnsupported')
                      : t('web.settings.system.launchAtLoginDesc')}
                  </span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  aria-label={t('web.refresh')}
                  className="size-7"
                  disabled={isFetchingStartup}
                  onClick={() => void refetchStartup()}
                  size="icon"
                  variant="ghost"
                >
                  <HugeiconsIcon
                    className={isFetchingStartup ? 'animate-spin' : undefined}
                    icon={RotateLeft01Icon}
                  />
                </Button>
                <Switch
                  aria-label={t('web.settings.system.launchAtLogin')}
                  checked={startup?.enabled === true}
                  disabled={isSavingStartup || startup?.supported === false}
                  onCheckedChange={handleStartup}
                />
              </div>
            </div>
          </section>

          <Separator />

          {/* Danger zone */}
          <section className="flex flex-col gap-3">
            <h3 className="font-semibold text-sm">{t('web.settings.system.reset')}</h3>
            <p className="text-muted-foreground text-xs">{t('web.settings.system.resetDesc')}</p>

            <div className="flex flex-col gap-2">
              {/* Reset usage */}
              <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm">{t('web.settings.system.resetUsage')}</span>
                  <span className="text-muted-foreground text-xs">{t('web.settings.system.resetUsageDesc')}</span>
                </div>
                <Button
                  className="gap-1.5"
                  disabled={isResettingUsage || usageResetDone}
                  onClick={handleResetUsage}
                  size="sm"
                  variant="outline"
                >
                  {usageResetDone ? (
                    <>
                      <HugeiconsIcon
                        className="size-3.5"
                        icon={CheckIcon}
                      />
                      {t('web.settings.system.done')}
                    </>
                  ) : isResettingUsage ? (
                    <HugeiconsIcon
                      className="size-3.5 animate-spin"
                      icon={LoaderPinwheelIcon}
                    />
                  ) : (
                    <>
                      <HugeiconsIcon
                        className="size-3.5"
                        icon={RotateLeft01Icon}
                      />
                      {t('web.settings.system.reset')}
                    </>
                  )}
                </Button>
              </div>

              {/* Clear all sessions */}
              <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm">{t('web.settings.system.clearSessions')}</span>
                  <span className="text-muted-foreground text-xs">
                    {t('web.settings.system.clearSessionsDesc', { count: sessionCount })}
                  </span>
                </div>
                <Button
                  className="gap-1.5"
                  disabled={clearingAllSessions || sessionsCleared || sessionCount === 0}
                  onClick={handleClearAllSessions}
                  size="sm"
                  variant="outline"
                >
                  {sessionsCleared ? (
                    <>
                      <HugeiconsIcon
                        className="size-3.5"
                        icon={CheckIcon}
                      />
                      {t('web.settings.system.done')}
                    </>
                  ) : clearingAllSessions ? (
                    <HugeiconsIcon
                      className="size-3.5 animate-spin"
                      icon={LoaderPinwheelIcon}
                    />
                  ) : (
                    <>
                      <HugeiconsIcon
                        className="size-3.5"
                        icon={Delete02Icon}
                      />
                      {t('web.settings.system.clearSessions')}
                    </>
                  )}
                </Button>
              </div>

              {/* CLI-only operations notice */}
              <div className="flex items-start gap-2 rounded-md border border-dashed px-3 py-2.5 text-muted-foreground">
                <HugeiconsIcon
                  className="mt-0.5 size-3.5 shrink-0"
                  icon={Alert01Icon}
                />
                <p className="text-xs">{t('web.settings.system.cliOnlyHint')}</p>
              </div>
            </div>
          </section>
        </div>
      </div>
    </ScrollArea>
  );
}

function upgradeStatusIsActive(latestVersion: string | undefined, version: string): boolean {
  return Boolean(latestVersion && latestVersion !== version);
}

function upgradeStageLabel(t: ReturnType<typeof useT>, stage: string): string {
  switch (stage) {
    case 'checking':
    case 'downloading':
    case 'verifying':
      return t('web.settings.system.upgradeStage.downloading');
    case 'installing':
      return t('web.settings.system.upgradeStage.installing');
    case 'restarting':
    case 'complete':
      return t('web.settings.system.upgradeStage.restart');
    case 'failed':
      return t('web.settings.system.upgradeStage.failed');
    default:
      return t('web.settings.system.upgradeStage.idle');
  }
}
