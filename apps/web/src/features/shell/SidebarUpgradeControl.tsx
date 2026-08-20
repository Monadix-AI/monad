import type { SystemUpgradeStatus } from '@monad/protocol';

import { Download04Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useGetSystemUpgradeQuery, useStartSystemUpgradeMutation } from '@monad/client-rtk';
import { Button, cn, Tooltip, TooltipContent, TooltipTrigger } from '@monad/ui';
import { useEffect, useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { ThemeToggle } from '#/components/ThemeToggle';
import { watchUpgradeRestartAndReload } from '#/lib/monad-store';

const BACKGROUND_CHECK_INTERVAL_MS = 5 * 60_000;

function upgradeStatusNeedsPolling(stage: SystemUpgradeStatus['stage'] | undefined): boolean {
  return (
    stage === 'checking' ||
    stage === 'downloading' ||
    stage === 'verifying' ||
    stage === 'installing' ||
    stage === 'restarting'
  );
}

function upgradeStatusIsBusy(stage: SystemUpgradeStatus['stage'] | undefined): boolean {
  return stage === 'downloading' || stage === 'verifying' || stage === 'installing' || stage === 'restarting';
}

export function SidebarUpgradeControl({
  daemonBaseUrl,
  daemonOnline,
  daemonVersion,
  hasUpgradeHint
}: {
  daemonBaseUrl: string;
  daemonOnline: boolean;
  daemonVersion?: string;
  hasUpgradeHint?: boolean;
}) {
  const t = useT();
  const [initialCheckPending, setInitialCheckPending] = useState(true);
  const [upgradeInitiated, setUpgradeInitiated] = useState(false);
  const [upgradePolling, setUpgradePolling] = useState(false);
  const [startSystemUpgrade, { isLoading: isStartingUpgrade }] = useStartSystemUpgradeMutation();
  const { data: upgradeStatus } = useGetSystemUpgradeQuery(undefined, {
    pollingInterval: initialCheckPending || upgradeInitiated || upgradePolling ? 1000 : BACKGROUND_CHECK_INTERVAL_MS,
    refetchOnMountOrArgChange: true,
    skip: !daemonOnline
  });
  const stage = upgradeStatus?.stage;
  const upgradeBusy = isStartingUpgrade || upgradeInitiated || upgradeStatusIsBusy(stage);
  const upgradeVisible = Boolean(hasUpgradeHint || upgradeStatus?.available || upgradeBusy);
  const restarting = stage === 'installing' || stage === 'restarting';
  const progress = Math.round(
    upgradeInitiated && (stage === 'checking' || stage === 'ready') ? 0 : (upgradeStatus?.progress ?? 0)
  );

  useEffect(() => {
    if (stage === 'complete' || stage === 'failed' || stage === 'ready') setInitialCheckPending(false);
    if (stage === 'failed') setUpgradeInitiated(false);
    setUpgradePolling(upgradeStatusNeedsPolling(stage));
  }, [stage]);

  if (!upgradeVisible) return <ThemeToggle />;

  const label = restarting
    ? `${t('web.settings.system.upgradeStage.restarting')}…`
    : upgradeBusy
      ? `${t('web.settings.system.upgradeStage.downloading')} ${progress}%`
      : t('web.settings.system.updateTitle');

  const startUpgrade = async () => {
    if (upgradeBusy) return;
    setUpgradeInitiated(true);
    watchUpgradeRestartAndReload({
      baseUrl: daemonBaseUrl,
      currentVersion: daemonVersion,
      targetVersion: upgradeStatus?.latestVersion
    });
    try {
      await startSystemUpgrade().unwrap();
    } catch {
      setUpgradeInitiated(false);
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          className={cn(
            'rounded-full bg-accent-blue text-white hover:bg-accent-blue/90 hover:text-white',
            upgradeBusy ? 'h-[22px] min-w-10 px-2 font-medium text-[11px] tabular-nums' : 'h-7 w-7 px-0'
          )}
          disabled={upgradeBusy}
          onClick={() => void startUpgrade()}
          size="sm"
        >
          {upgradeBusy ? (
            restarting ? (
              `${t('web.settings.system.upgradeStage.restarting')}…`
            ) : (
              `${progress}%`
            )
          ) : (
            <HugeiconsIcon
              className="size-4"
              icon={Download04Icon}
            />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
