'use client';

import {
  useDeleteSessionMutation,
  useGetDeveloperQuery,
  useGetHealthQuery,
  useGetStartupQuery,
  useListSessionsQuery,
  useResetUsageMutation,
  useSetDeveloperMutation,
  useSetStartupMutation
} from '@monad/client-rtk';
import { Badge, Button, ScrollArea, Separator, Switch } from '@monad/ui';
import {
  AlertTriangle,
  ArrowUpCircle,
  Check,
  Code2,
  Hand,
  Loader2,
  Power,
  RefreshCcw,
  RotateCcw,
  Trash2,
  X
} from 'lucide-react';
import { useEffect, useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { isInteractiveCursorEnabled, setInteractiveCursorEnabled } from '@/lib/interactive-cursor';

interface Props {
  onClose: () => void;
}

export function SystemSettings({ onClose }: Props) {
  const t = useT();
  const { data: health, isLoading } = useGetHealthQuery();
  const [resetUsage, { isLoading: isResettingUsage }] = useResetUsageMutation();
  const { data: developer } = useGetDeveloperQuery();
  const [setDeveloper, { isLoading: isSavingDeveloper }] = useSetDeveloperMutation();
  const { data: startup } = useGetStartupQuery();
  const [setStartup, { isLoading: isSavingStartup }] = useSetStartupMutation();
  const [usageResetDone, setUsageResetDone] = useState(false);
  const { data: sessionData } = useListSessionsQuery(undefined);
  const sessionIds = Object.keys(sessionData?.sessions?.entities ?? {});
  const sessionCount = sessionIds.length;
  const [deleteSession] = useDeleteSessionMutation();
  const [clearingAllSessions, setClearingAllSessions] = useState(false);
  const [sessionsCleared, setSessionsCleared] = useState(false);
  const [interactiveCursor, setInteractiveCursor] = useState(false);

  const version = health?.version ?? '—';
  const latestVersion = (health as { latestVersion?: string } | undefined)?.latestVersion;
  const hasUpgrade = latestVersion && latestVersion !== version;

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

  useEffect(() => {
    setInteractiveCursor(isInteractiveCursorEnabled());
  }, []);

  function handleInteractiveCursor(enabled: boolean) {
    setInteractiveCursor(enabled);
    setInteractiveCursorEnabled(enabled);
  }

  return (
    <ScrollArea className="h-full">
      <div className="flex min-h-full flex-col">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <div className="flex items-center gap-2">
            <RefreshCcw className="size-4 text-muted-foreground" />
            <span className="font-semibold text-sm">{t('web.settings.system')}</span>
          </div>
          <Button
            aria-label={t('web.close')}
            className="size-7"
            onClick={onClose}
            size="icon"
            variant="ghost"
          >
            <X />
          </Button>
        </div>

        <div className="flex flex-col gap-6 p-6">
          {/* Version & upgrade */}
          <section className="flex flex-col gap-3">
            <h3 className="font-semibold text-sm">{t('web.settings.system.version')}</h3>
            <div className="flex items-center gap-3">
              {isLoading ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              ) : (
                <>
                  <span className="font-mono text-sm">{version}</span>
                  {hasUpgrade ? (
                    <Badge
                      className="gap-1 text-xs"
                      variant="outline"
                    >
                      <ArrowUpCircle className="size-3" />
                      {t('web.settings.system.updateAvailable', { version: latestVersion })}
                    </Badge>
                  ) : (
                    <Badge
                      className="gap-1 text-xs"
                      variant="secondary"
                    >
                      <Check className="size-3" />
                      {t('web.settings.system.upToDate')}
                    </Badge>
                  )}
                </>
              )}
            </div>
            {hasUpgrade && (
              <p className="text-muted-foreground text-xs">
                {t('web.settings.system.upgradeHint')}
                <code className="ml-1 rounded bg-muted px-1 py-0.5 font-mono text-xs">monad upgrade</code>
              </p>
            )}
          </section>

          <Separator />

          <section className="flex flex-col gap-3">
            <h3 className="font-semibold text-sm">{t('web.settings.system.developer')}</h3>
            <div className="flex items-center justify-between gap-4 rounded-md border px-3 py-2.5">
              <div className="flex min-w-0 items-start gap-2">
                <Code2 className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
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
                <Power className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm">{t('web.settings.system.launchAtLogin')}</span>
                  <span className="text-muted-foreground text-xs">
                    {startup?.supported === false
                      ? t('web.settings.system.launchAtLoginUnsupported')
                      : t('web.settings.system.launchAtLoginDesc')}
                  </span>
                </div>
              </div>
              <Switch
                aria-label={t('web.settings.system.launchAtLogin')}
                checked={startup?.enabled === true}
                disabled={isSavingStartup || startup?.supported === false}
                onCheckedChange={handleStartup}
              />
            </div>
          </section>

          <Separator />

          <section className="flex flex-col gap-3">
            <h3 className="font-semibold text-sm">{t('web.settings.system.interactiveCursor')}</h3>
            <div className="flex items-center justify-between gap-4 rounded-md border px-3 py-2.5">
              <div className="flex min-w-0 items-start gap-2">
                <Hand className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm">{t('web.settings.system.interactiveCursor')}</span>
                  <span className="text-muted-foreground text-xs">
                    {t('web.settings.system.interactiveCursorDesc')}
                  </span>
                </div>
              </div>
              <Switch
                aria-label={t('web.settings.system.interactiveCursor')}
                checked={interactiveCursor}
                onCheckedChange={handleInteractiveCursor}
              />
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
                      <Check className="size-3.5" />
                      {t('web.settings.system.done')}
                    </>
                  ) : isResettingUsage ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <>
                      <RotateCcw className="size-3.5" />
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
                      <Check className="size-3.5" />
                      {t('web.settings.system.done')}
                    </>
                  ) : clearingAllSessions ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <>
                      <Trash2 className="size-3.5" />
                      {t('web.settings.system.clearSessions')}
                    </>
                  )}
                </Button>
              </div>

              {/* CLI-only operations notice */}
              <div className="flex items-start gap-2 rounded-md border border-dashed px-3 py-2.5 text-muted-foreground">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <p className="text-xs">{t('web.settings.system.cliOnlyHint')}</p>
              </div>
            </div>
          </section>
        </div>
      </div>
    </ScrollArea>
  );
}
