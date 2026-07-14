import {
  Alert01Icon,
  ArrowUpRight01Icon,
  CheckIcon,
  Delete02Icon,
  FileCodeIcon,
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
  useOpenStartupSettingsMutation,
  useResetUsageMutation,
  useSetDeveloperMutation,
  useSetStartupMutation,
  useStartSystemUpgradeMutation
} from '@monad/client-rtk';
import { Badge, Button, ScrollArea, Separator, Skeleton, Switch } from '@monad/ui';
import { useEffect, useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { resolveConnection, watchUpgradeRestartAndReload } from '#/lib/monad-store';

export function SystemSettings() {
  const t = useT();
  const { data: health, isLoading } = useGetHealthQuery();
  const [resetUsage, { isLoading: isResettingUsage }] = useResetUsageMutation();
  const { data: developer } = useGetDeveloperQuery();
  const [setDeveloper, { isLoading: isSavingDeveloper }] = useSetDeveloperMutation();
  const { data: startup } = useGetStartupQuery(undefined, {
    refetchOnMountOrArgChange: true
  });
  const [openStartupSettings, { isLoading: isOpeningStartupSettings }] = useOpenStartupSettingsMutation();
  const [setStartup, { isLoading: isSavingStartup }] = useSetStartupMutation();
  const [usageResetDone, setUsageResetDone] = useState(false);
  const { data: sessionData } = useListSessionsQuery(undefined);
  const sessionIds = Object.keys(sessionData?.sessions?.entities ?? {});
  const sessionCount = sessionIds.length;
  const [deleteSession] = useDeleteSessionMutation();
  const [clearingAllSessions, setClearingAllSessions] = useState(false);
  const [sessionsCleared, setSessionsCleared] = useState(false);
  const [upgradePolling, setUpgradePolling] = useState(false);

  const version = health?.version ?? '—';
  const latestVersion = (health as { latestVersion?: string } | undefined)?.latestVersion;
  const hasUpgrade = latestVersion && latestVersion !== version;
  const [startSystemUpgrade, { isLoading: isStartingUpgrade }] = useStartSystemUpgradeMutation();
  const { data: upgradeStatus } = useGetSystemUpgradeQuery(undefined, {
    pollingInterval: isStartingUpgrade || upgradePolling ? 1000 : 0
  });
  const upgradeStage = upgradeStatus?.stage ?? 'idle';
  const upgradeActive =
    upgradeStage === 'checking' ||
    upgradeStage === 'downloading' ||
    upgradeStage === 'verifying' ||
    upgradeStage === 'installing' ||
    upgradeStage === 'restarting';
  const upgradeProgress = upgradeStatus?.progress ?? 0;

  useEffect(() => {
    setUpgradePolling(upgradeActive);
  }, [upgradeActive]);

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

  async function handleUpgrade() {
    watchUpgradeRestartAndReload({
      baseUrl: resolveConnection().baseUrl,
      currentVersion: version,
      targetVersion: upgradeStatus?.latestVersion ?? latestVersion
    });
    await startSystemUpgrade().unwrap();
  }

  return (
    <ScrollArea className="h-full">
      <div className="flex min-h-full flex-col">
        <div className="flex flex-col gap-6 p-6">
          {/* Version & upgrade */}
          <section className="flex flex-col gap-3">
            <h3 className="font-semibold text-sm">{t('web.settings.system.version')}</h3>
            <div className="flex items-center gap-3">
              {isLoading && !health ? (
                <>
                  <Skeleton className="h-5 w-24 rounded" />
                  <Skeleton className="h-5 w-20 rounded-full" />
                </>
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
                  aria-label={t('web.settings.system.openStartupSettings')}
                  className="size-7 text-muted-foreground"
                  disabled={isOpeningStartupSettings || startup?.supported === false}
                  onClick={() => void openStartupSettings()}
                  size="icon"
                  title={t('web.settings.system.openStartupSettings')}
                  variant="ghost"
                >
                  <HugeiconsIcon icon={ArrowUpRight01Icon} />
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
