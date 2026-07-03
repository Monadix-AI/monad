'use client';

import type { VersionCheckResult } from '@monad/client';

import {
  AlertCircleIcon,
  CircleCheckIcon,
  Link01Icon,
  LoaderPinwheelIcon,
  ServerStack01Icon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { checkDaemonVersion } from '@monad/client';
import { Button, cn, Input, Label } from '@monad/ui';
import { useState } from 'react';

import { useT } from '@/components/I18nProvider';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { normalizeDaemonUrl, type RemoteDaemonConnection, saveRemoteDaemonConnection } from '@/lib/daemon-connections';

export function RemoteDaemonDialog({
  onConnected,
  onOpenChange,
  open
}: {
  onConnected: (connection: RemoteDaemonConnection) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const t = useT();
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<
    { status: 'idle' } | { status: 'checking' } | { result: VersionCheckResult; status: 'done' }
  >({ status: 'idle' });
  const checking = check.status === 'checking';
  const trimmedUrl = url.trim();
  const daemonUrlMessages = {
    clean: t('web.remoteDaemon.urlErrorClean'),
    empty: t('web.remoteDaemon.urlErrorEmpty'),
    host: t('web.remoteDaemon.urlErrorHost'),
    invalid: t('web.remoteDaemon.urlErrorInvalid'),
    protocol: t('web.remoteDaemon.urlErrorProtocol')
  };
  const normalizedPreview = trimmedUrl ? normalizeDaemonUrl(trimmedUrl, daemonUrlMessages) : null;
  const previewUrl = normalizedPreview && !normalizedPreview.error ? normalizedPreview.url : null;

  const reset = () => {
    setError(null);
    setCheck({ status: 'idle' });
  };

  async function handleConnect() {
    const normalized = normalizeDaemonUrl(url, daemonUrlMessages);
    if (normalized.error) {
      setError(normalized.error);
      return;
    }
    const normalizedUrl = normalized.url;
    if (!normalizedUrl) return;

    setError(null);
    setCheck({ status: 'checking' });
    let result: VersionCheckResult;
    try {
      result = await checkDaemonVersion(normalizedUrl);
    } catch {
      setCheck({ status: 'idle' });
      setError(t('web.remoteDaemon.connectError'));
      return;
    }
    setCheck({ status: 'done', result });

    if (!result.compatible) {
      setError(result.reason || t('web.remoteDaemon.compatError'));
      return;
    }

    const connection = saveRemoteDaemonConnection({
      url: normalizedUrl,
      version: result.daemonVersion
    });
    onConnected(connection);
  }

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (!checking) onOpenChange(nextOpen);
      }}
      open={open}
    >
      <DialogContent
        className="sm:max-w-[31rem]"
        showCloseButton={!checking}
      >
        <DialogHeader className="gap-2 pr-8">
          <div className="flex size-9 items-center justify-center rounded-(--radius-md) border border-border/70 bg-background/70">
            <HugeiconsIcon
              className="size-4 text-muted-foreground"
              icon={ServerStack01Icon}
            />
          </div>
          <DialogTitle>{t('web.remoteDaemon.title')}</DialogTitle>
          <DialogDescription className="max-w-[32rem]">{t('web.remoteDaemon.desc')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="remote-daemon-url">{t('web.remoteDaemon.urlLabel')}</Label>
            <span className="text-muted-foreground text-xs">{t('web.remoteDaemon.urlProtocol')}</span>
          </div>
          <Input
            aria-describedby="remote-daemon-url-help remote-daemon-status"
            aria-invalid={Boolean(error) || undefined}
            autoComplete="url"
            disabled={checking}
            id="remote-daemon-url"
            onChange={(event) => {
              setUrl(event.target.value);
              reset();
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void handleConnect();
            }}
            placeholder="http://192.168.1.100:52749"
            value={url}
          />
          <p
            className="text-muted-foreground text-xs"
            id="remote-daemon-url-help"
          >
            {t('web.remoteDaemon.urlHelp')}
          </p>

          <div
            className={cn(
              'flex min-h-12 items-start gap-3 rounded-(--radius-md) border border-border/70 bg-background/55 px-3 py-2.5 text-sm',
              error && 'border-destructive/40 bg-destructive/8 text-destructive'
            )}
            id="remote-daemon-status"
            role={error ? 'alert' : 'status'}
          >
            {checking ? (
              <HugeiconsIcon
                className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground"
                icon={LoaderPinwheelIcon}
              />
            ) : error ? (
              <HugeiconsIcon
                className="mt-0.5 size-4 shrink-0"
                icon={AlertCircleIcon}
              />
            ) : previewUrl ? (
              <HugeiconsIcon
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                icon={Link01Icon}
              />
            ) : (
              <HugeiconsIcon
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                icon={CircleCheckIcon}
              />
            )}
            <div className="min-w-0 space-y-0.5">
              <p className={cn('font-medium', !error && 'text-foreground')}>
                {checking
                  ? t('web.remoteDaemon.checking')
                  : error
                    ? error
                    : previewUrl
                      ? t('web.remoteDaemon.ready')
                      : t('web.remoteDaemon.enterUrl')}
              </p>
              <p className={cn('break-all text-xs', error ? 'text-destructive/80' : 'text-muted-foreground')}>
                {checking
                  ? t('web.remoteDaemon.checkingHint')
                  : error
                    ? t('web.remoteDaemon.fixHint')
                    : previewUrl
                      ? previewUrl
                      : t('web.remoteDaemon.savedHint')}
              </p>
            </div>
          </div>
        </div>

        <DialogFooter className="items-center gap-2 sm:justify-between">
          <p className="text-muted-foreground text-xs sm:max-w-[16rem]">{t('web.remoteDaemon.localHint')}</p>
          <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
            <Button
              disabled={checking}
              onClick={() => onOpenChange(false)}
              variant="outline"
            >
              {t('web.cancel')}
            </Button>
            <Button
              disabled={checking || !trimmedUrl}
              onClick={() => void handleConnect()}
            >
              {checking ? (
                <>
                  <HugeiconsIcon
                    className="animate-spin"
                    icon={LoaderPinwheelIcon}
                  />
                  {t('web.remoteDaemon.connecting')}
                </>
              ) : (
                t('web.remoteDaemon.connect')
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
