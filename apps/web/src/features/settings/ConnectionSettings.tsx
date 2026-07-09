'use client';

import type { NetworkSettings } from '@monad/protocol';

import { Alert01Icon, Copy01Icon, GlobeIcon, RotateLeft01Icon, Shield01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button, Input, Label, ScrollArea, Switch } from '@monad/ui';
import { useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { useNetworkSettings } from '#/hooks/use-network-settings';
import { REMOTE_URL_KEY } from '#/lib/monad-store';
import { SECRET_INPUT_PASSWORD_MANAGER_PROPS } from '#/lib/secret-input-props';
import { localHttpFallbackState, localHttpFallbackUrl } from './network-endpoints';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHttpsReady(settings: NetworkSettings, target: URL): Promise<void> {
  const fallback = localHttpFallbackUrl(settings);
  if (!fallback) {
    // No HTTP endpoint to health-poll. Best-effort poll the HTTPS target itself (only
    // succeeds once its listener is up AND the self-signed cert is already trusted), then
    // redirect regardless after a grace window so a slow openssl cert-gen doesn't strand the
    // user on a refused connection. The redirect itself surfaces the cert prompt.
    const targetHealth = new URL('/health', target).toString();
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(targetHealth, { cache: 'no-store' });
        if (res.ok) return;
      } catch {
        // listener not up yet, or cert not yet trusted — keep waiting
      }
      await sleep(300);
    }
    return;
  }

  const healthUrl = new URL('/health', fallback);
  const targetPort = Number(target.port);
  const deadline = Date.now() + 8000;
  let lastError: string | undefined;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl.toString(), { cache: 'no-store' });
      if (res.ok) {
        const health = (await res.json()) as {
          networkRuntime?: {
            listeners?: { scheme: string; port: number }[];
            lastError?: { message?: string };
          };
        };
        const hasHttps = health.networkRuntime?.listeners?.some(
          (listener) => listener.scheme === 'https' && listener.port === targetPort
        );
        if (hasHttps && !health.networkRuntime?.lastError) return;
        lastError = health.networkRuntime?.lastError?.message;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(250);
  }

  throw new Error(lastError ?? 'Timed out waiting for HTTPS listener');
}

export function ConnectionSettings() {
  const t = useT();
  const network = useNetworkSettings();
  const [networkCopied, setNetworkCopied] = useState(false);
  const [httpsTransition, setHttpsTransition] = useState<'idle' | 'to-https' | 'to-http' | 'error'>('idle');
  const [httpsTransitionError, setHttpsTransitionError] = useState<string | undefined>();

  async function toggleRemoteAccess(enabled: boolean) {
    await network.set({ remoteAccess: { enabled } });
  }

  async function toggleHttps(enabled: boolean) {
    const changingScheme = enabled !== (network.settings?.https.enabled !== false);
    if (!changingScheme) {
      setHttpsTransition('idle');
      setHttpsTransitionError(undefined);
      await network.set({ https: { enabled } });
      return;
    }

    setHttpsTransition(enabled ? 'to-https' : 'to-http');
    setHttpsTransitionError(undefined);
    try {
      const next = await network.set({
        https: { enabled },
        ...(!enabled && network.settings?.remoteAccess.enabled ? { remoteAccess: { enabled: false } } : {})
      });
      const target = new URL(window.location.href);
      target.protocol = enabled ? 'https:' : 'http:';
      target.hostname = next.host === '0.0.0.0' ? window.location.hostname : next.host;
      target.port = String(next.port);
      if (enabled) await waitForHttpsReady(next, target);
      else await sleep(750);
      window.location.replace(target.toString());
    } catch (err) {
      setHttpsTransition('error');
      setHttpsTransitionError(err instanceof Error ? err.message : String(err));
    }
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

  const isRemote = !!localStorage.getItem(REMOTE_URL_KEY)?.trim();
  const switchingScheme = httpsTransition === 'to-https' || httpsTransition === 'to-http';
  const switchingToHttps = httpsTransition === 'to-https';
  const switchingToHttp = httpsTransition === 'to-http';
  const networkBusy = network.loading || network.saving || switchingScheme;
  const daemonScheme = switchingToHttp
    ? 'http'
    : switchingToHttps || network.settings?.https?.enabled !== false
      ? 'https'
      : 'http';
  const httpsDisabled = !switchingToHttps && network.settings?.https?.enabled === false;
  const remoteHttpExposed = httpsDisabled && network.settings?.remoteAccess?.enabled === true;
  const daemonHost = network.settings?.host ?? '127.0.0.1';
  const fallbackState = localHttpFallbackState(network.settings);
  const fallbackUrl = localHttpFallbackUrl(network.settings);
  const fallbackLabel =
    fallbackUrl ?? (fallbackState === 'unavailable' ? t('web.skills.unavailable') : t('web.api.disabled'));

  const networkSection = (className = 'flex flex-col gap-3') => (
    <section className={className}>
      <h3 className="font-semibold text-sm">{t('web.settings.system.network')}</h3>
      <div className="overflow-hidden rounded-md border text-xs">
        <div className="grid grid-cols-[minmax(9rem,0.4fr)_minmax(0,1fr)] border-b">
          <div className="bg-muted px-3 py-2 text-muted-foreground">{t('web.conn.localEndpoint')}</div>
          <code className="min-w-0 break-all px-3 py-2 font-mono text-foreground">
            {daemonScheme}://{daemonHost}:{network.settings?.port ?? 52749}
          </code>
        </div>
        <div className="grid grid-cols-[minmax(9rem,0.4fr)_minmax(0,1fr)]">
          <div className="bg-muted px-3 py-2 text-muted-foreground">{t('web.settings.system.localHttpEndpoint')}</div>
          <code className="min-w-0 break-all px-3 py-2 font-mono text-foreground">{fallbackLabel}</code>
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
          disabled={networkBusy}
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
          checked={switchingToHttps || network.settings?.https.enabled !== false}
          disabled={networkBusy}
          onCheckedChange={(checked) => void toggleHttps(checked)}
        />
      </div>

      {switchingScheme ? (
        <div className="flex items-center gap-2 rounded border border-primary/30 bg-primary/5 px-2.5 py-2 text-primary text-xs">
          <span className="size-3.5 shrink-0 animate-spin rounded-full border border-current border-t-transparent" />
          <span>
            {switchingToHttps ? 'Generating TLS certificate and switching to HTTPS...' : 'Switching to HTTP...'}
          </span>
        </div>
      ) : null}

      {httpsTransitionError ? (
        <div className="flex items-start gap-2 rounded border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-destructive text-xs">
          <HugeiconsIcon
            className="mt-0.5 size-3.5 shrink-0"
            icon={Alert01Icon}
          />
          <span>{httpsTransitionError}</span>
        </div>
      ) : null}

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
          disabled={networkBusy}
          onCheckedChange={(checked) => void toggleRemoteAccess(checked)}
        />
      </div>

      <div className="flex items-start gap-2 rounded-md border bg-muted/30 px-3 py-2.5 text-muted-foreground text-xs">
        <HugeiconsIcon
          className="mt-0.5 size-3.5 shrink-0"
          icon={Shield01Icon}
        />
        <span>{t('web.conn.remoteAccessTlsHint')}</span>
      </div>

      {network.settings?.remoteAccess.enabled ? (
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
              disabled={networkBusy}
              onClick={() => void rotateRemoteToken()}
              size="icon"
              variant="outline"
            >
              <HugeiconsIcon icon={RotateLeft01Icon} />
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-4 rounded-md border px-3 py-2.5">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm">{t('web.settings.system.localHttpFallback')}</span>
          <span className="text-muted-foreground text-xs">{t('web.settings.system.localHttpFallbackDesc')}</span>
        </div>
        <Switch
          aria-label={t('web.settings.system.localHttpFallback')}
          checked={network.settings?.localHttpFallback.enabled === true}
          disabled={networkBusy}
          onCheckedChange={(checked) => void toggleLocalHttpFallback(checked)}
        />
      </div>

      {network.settings?.restartRequired ? (
        <div className="flex items-start gap-2 rounded border border-warning/30 bg-warning/5 px-2.5 py-2 text-warning text-xs">
          <HugeiconsIcon
            className="mt-0.5 size-3.5 shrink-0"
            icon={Alert01Icon}
          />
          <span>{t('web.conn.restartRequired')}</span>
        </div>
      ) : null}
      {network.error ? <div className="text-destructive text-xs">{network.error}</div> : null}
    </section>
  );

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 px-6 py-5 pt-4">
          {isRemote ? (
            <div className="flex items-center gap-2">
              <HugeiconsIcon
                className="size-4 text-muted-foreground"
                icon={GlobeIcon}
              />
              <span className="rounded bg-primary/10 px-1.5 py-0.5 font-medium text-[10px] text-primary uppercase tracking-wide">
                {t('web.conn.remote')}
              </span>
            </div>
          ) : null}
          <div className="grid gap-2 rounded-md border bg-muted/30 px-3 py-2.5 sm:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-1">
              <span className="font-semibold text-sm">{t('web.conn.localEndpoint')}</span>
              <code className="min-w-0 break-all font-mono text-foreground text-xs">
                {daemonScheme}://{daemonHost}:{network.settings?.port ?? 52749}
              </code>
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <span className="font-semibold text-sm">{t('web.settings.system.localHttpEndpoint')}</span>
              <code className="min-w-0 break-all font-mono text-foreground text-xs">{fallbackLabel}</code>
            </div>
          </div>
          {networkSection()}
        </div>
      </ScrollArea>
    </div>
  );
}
