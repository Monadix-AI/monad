'use client';

import type { VersionCheckResult } from '@monad/client';
import type { GetHealthResponse } from '@monad/protocol';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  Alert01Icon,
  Cancel01Icon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  Copy01Icon,
  GlobeIcon,
  LoaderPinwheelIcon,
  RotateLeft01Icon,
  Shield01Icon,
  ShieldQuestionMarkIcon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { checkDaemonVersion } from '@monad/client';
import { Button, Input, Label, ScrollArea, Switch } from '@monad/ui';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';

import { I18nTrans, useT } from '@/components/I18nProvider';
import { useNetworkSettings } from '@/hooks/use-network-settings';
import { saveRemoteDaemonConnection } from '@/lib/daemon-connections';
import { daemonConnectionFormSchema } from '@/lib/form-validation';
import { useMonadRuntime } from '@/lib/monad-runtime-provider';
import { REMOTE_TOKEN_KEY, REMOTE_URL_KEY } from '@/lib/monad-store';
import { SECRET_INPUT_PASSWORD_MANAGER_PROPS } from '@/lib/secret-input-props';

interface Props {
  onClose: () => void;
}

type CheckState = { status: 'idle' } | { status: 'checking' } | { status: 'done'; result: VersionCheckResult };

type CertFpState =
  | { fp: string; status: 'new' }
  | { fp: string; status: 'verified' }
  | { fp: string; stored: string; status: 'changed' };

// Per-daemon localStorage key so local and remote fingerprints are stored separately.
function certFpKey(remoteUrl: string): string {
  return remoteUrl.trim() ? `monad:tls:fp:${remoteUrl.trim()}` : 'monad:tls:fp:local';
}

const EXPIRY_WARN_DAYS = 30;

export function ConnectionSettings({ onClose }: Props) {
  const t = useT();
  const { switchDaemonConnection } = useMonadRuntime();
  const network = useNetworkSettings();
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [check, setCheck] = useState<CheckState>({ status: 'idle' });
  const [tlsWarning, setTlsWarning] = useState<'openssl' | 'cert-error' | null>(null);
  const [certFp, setCertFp] = useState<CertFpState | null>(null);
  const [daysUntilExpiry, setDaysUntilExpiry] = useState<number | null>(null);
  const [networkCopied, setNetworkCopied] = useState(false);
  const connectionForm = useForm({
    values: { url, token },
    resolver: zodResolver(daemonConnectionFormSchema)
  });
  const urlError = connectionForm.formState.errors.url ? t('web.url.httpOnly') : null;

  useEffect(() => {
    const storedUrl = localStorage.getItem(REMOTE_URL_KEY) ?? '';
    const storedToken = localStorage.getItem(REMOTE_TOKEN_KEY) ?? '';
    setUrl(storedUrl);
    setToken(storedToken);

    const healthUrl = storedUrl.trim() ? `${storedUrl.trim()}/health` : '/health';
    const headers: Record<string, string> = storedToken.trim() ? { authorization: `Bearer ${storedToken.trim()}` } : {};

    fetch(healthUrl, { headers })
      .then((r) => r.json())
      .then((data: GetHealthResponse) => {
        if (data.warnings?.includes('tls:openssl-not-found')) setTlsWarning('openssl');
        else if (data.warnings?.includes('tls:cert-error')) setTlsWarning('cert-error');

        if (data.certFingerprint) {
          const key = certFpKey(storedUrl);
          const stored = localStorage.getItem(key);
          if (!stored) {
            localStorage.setItem(key, data.certFingerprint);
            setCertFp({ fp: data.certFingerprint, status: 'new' });
          } else if (stored === data.certFingerprint) {
            setCertFp({ fp: data.certFingerprint, status: 'verified' });
          } else {
            setCertFp({ fp: data.certFingerprint, stored, status: 'changed' });
          }
        }

        if (data.certExpiry) {
          const msLeft = new Date(data.certExpiry).getTime() - Date.now();
          const days = Math.floor(msLeft / 86_400_000);
          if (days < EXPIRY_WARN_DAYS) setDaysUntilExpiry(days);
        }
      })
      .catch(() => {});
  }, []);

  function trustNewFingerprint() {
    if (certFp?.status !== 'changed') return;
    const key = certFpKey(url);
    localStorage.setItem(key, certFp.fp);
    setCertFp({ fp: certFp.fp, status: 'verified' });
  }

  function resetCheck() {
    setCheck({ status: 'idle' });
  }

  const handleSave = connectionForm.handleSubmit(async ({ url: trimmedUrl, token: trimmedToken }) => {
    if (trimmedUrl) {
      setCheck({ status: 'checking' });
      const result = await checkDaemonVersion(trimmedUrl, trimmedToken || undefined);
      setCheck({ status: 'done', result });
      if (!result.compatible) return;
    }

    if (trimmedUrl) {
      localStorage.setItem(REMOTE_URL_KEY, trimmedUrl);
      if (check.status === 'done' && check.result.compatible) {
        saveRemoteDaemonConnection({ url: trimmedUrl, version: check.result.daemonVersion });
      }
    } else {
      localStorage.removeItem(REMOTE_URL_KEY);
    }
    if (trimmedToken) {
      localStorage.setItem(REMOTE_TOKEN_KEY, trimmedToken);
    } else {
      localStorage.removeItem(REMOTE_TOKEN_KEY);
    }
    if (trimmedUrl) switchDaemonConnection({ connection: { url: trimmedUrl }, type: 'remote' });
    else switchDaemonConnection({ type: 'local' });
  });

  function handleClear() {
    localStorage.removeItem(REMOTE_URL_KEY);
    localStorage.removeItem(REMOTE_TOKEN_KEY);
    switchDaemonConnection({ type: 'local' });
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

  const isRemote = !!localStorage.getItem(REMOTE_URL_KEY)?.trim();
  const checking = check.status === 'checking';
  const daemonScheme = network.settings?.https.enabled === false ? 'http' : 'https';
  const httpsDisabled = network.settings?.https.enabled === false;
  const remoteHttpExposed = httpsDisabled && network.settings?.remoteAccess.enabled === true;
  const daemonHost = network.settings?.host ?? '127.0.0.1';

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b px-6 py-4">
        <div className="flex items-center gap-2">
          <HugeiconsIcon
            className="size-4 text-muted-foreground"
            icon={GlobeIcon}
          />
          <span className="font-semibold text-sm">{t('web.conn.title')}</span>
          {isRemote && (
            <span className="rounded bg-primary/10 px-1.5 py-0.5 font-medium text-[10px] text-primary uppercase tracking-wide">
              {t('web.conn.remote')}
            </span>
          )}
        </div>
        <Button
          aria-label={t('web.close')}
          className="size-7"
          onClick={onClose}
          size="icon"
          variant="ghost"
        >
          <HugeiconsIcon icon={Cancel01Icon} />
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 px-6 py-5">
          <p className="max-w-[76ch] text-muted-foreground text-sm">{t('web.conn.intro')}</p>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="daemon-url">{t('web.conn.urlLabel')}</Label>
              <Input
                aria-invalid={!!urlError || undefined}
                id="daemon-url"
                onChange={(e) => {
                  setUrl(e.target.value);
                  connectionForm.clearErrors('url');
                  resetCheck();
                }}
                placeholder="https://192.168.1.100:52749"
                value={url}
              />
              {urlError ? <p className="text-destructive text-xs">{urlError}</p> : null}
              <p className="text-muted-foreground text-xs">
                <I18nTrans
                  components={{ code: <code /> }}
                  i18nKey="web.conn.urlHint"
                />
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="daemon-token">{t('web.conn.tokenLabel')}</Label>
              <Input
                className="[-webkit-text-security:disc]"
                id="daemon-token"
                onChange={(e) => {
                  setToken(e.target.value);
                  resetCheck();
                }}
                placeholder={t('web.conn.tokenPlaceholder')}
                value={token}
                {...SECRET_INPUT_PASSWORD_MANAGER_PROPS}
              />
            </div>
          </div>

          {/* TLS warning: openssl missing or cert generation failed */}
          {tlsWarning && (
            <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2.5 text-sm text-warning">
              <HugeiconsIcon
                className="mt-0.5 size-4 shrink-0"
                icon={Alert01Icon}
              />
              <div className="flex flex-col gap-0.5">
                <span className="font-medium">{t('web.conn.tlsWarningTitle')}</span>
                <span className="text-xs opacity-80">
                  {tlsWarning === 'openssl' ? t('web.conn.tlsWarningOpenssl') : t('web.conn.tlsWarningCertError')}
                </span>
              </div>
            </div>
          )}

          {/* Cert expiry warning */}
          {daysUntilExpiry !== null && (
            <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2.5 text-sm text-warning">
              <HugeiconsIcon
                className="mt-0.5 size-4 shrink-0"
                icon={Alert01Icon}
              />
              <div className="flex flex-col gap-0.5">
                <span className="font-medium">
                  {t('web.conn.certExpiryWarning', { days: daysUntilExpiry, count: daysUntilExpiry })}
                </span>
                <span className="text-xs opacity-80">{t('web.conn.certExpiryHint')}</span>
              </div>
            </div>
          )}

          {/* TOFU fingerprint — changed (most prominent) */}
          {certFp?.status === 'changed' && (
            <div className="flex flex-col gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-destructive text-sm">
              <div className="flex items-start gap-2">
                <HugeiconsIcon
                  className="mt-0.5 size-4 shrink-0"
                  icon={ShieldQuestionMarkIcon}
                />
                <div className="flex flex-col gap-0.5">
                  <span className="font-medium">{t('web.conn.certFpChanged')}</span>
                  <span className="text-xs opacity-80">{t('web.conn.certFpChangedHint')}</span>
                </div>
              </div>
              <div className="flex flex-col gap-0.5 pl-6">
                <span className="text-[10px] text-muted-foreground">new</span>
                <code className="select-all break-all font-mono text-[11px]">{certFp.fp}</code>
                <span className="mt-1 text-[10px] text-muted-foreground">previously trusted</span>
                <code className="select-all break-all font-mono text-[11px] opacity-60">{certFp.stored}</code>
              </div>
              <Button
                className="ml-6 self-start"
                onClick={trustNewFingerprint}
                size="sm"
                variant="outline"
              >
                {t('web.conn.certFpTrust')}
              </Button>
            </div>
          )}

          {/* TOFU fingerprint — verified or new */}
          {certFp && certFp.status !== 'changed' && (
            <div className="flex flex-col gap-1 rounded-md border bg-muted/30 px-3 py-2.5">
              <div className="flex items-center gap-1.5">
                {certFp.status === 'verified' ? (
                  <HugeiconsIcon
                    className="size-3.5 text-success"
                    icon={Shield01Icon}
                  />
                ) : (
                  <HugeiconsIcon
                    className="size-3.5 text-muted-foreground"
                    icon={Shield01Icon}
                  />
                )}
                <span className="font-medium text-muted-foreground text-xs">{t('web.conn.certFpLabel')}</span>
              </div>
              <code className="select-all break-all font-mono text-[11px] text-foreground/80">{certFp.fp}</code>
              <span className="text-[10px] text-muted-foreground/70">
                {certFp.status === 'verified' ? t('web.conn.certFpVerified') : t('web.conn.certFpNew')}
              </span>
            </div>
          )}

          {/* Version check result */}
          {check.status === 'done' && (
            <div
              className={`flex items-start gap-2 rounded-md border px-3 py-2.5 text-sm ${
                check.result.compatible
                  ? 'border-success/30 bg-success/5 text-success'
                  : 'border-destructive/30 bg-destructive/5 text-destructive'
              }`}
            >
              {check.result.compatible ? (
                <HugeiconsIcon
                  className="mt-0.5 size-4 shrink-0"
                  icon={CheckmarkCircle02Icon}
                />
              ) : (
                <HugeiconsIcon
                  className="mt-0.5 size-4 shrink-0"
                  icon={CancelCircleIcon}
                />
              )}
              <div className="flex flex-col gap-0.5">
                {check.result.compatible ? (
                  <span>
                    <I18nTrans
                      components={{ code: <code /> }}
                      i18nKey="web.conn.connected"
                      values={{ version: check.result.daemonVersion }}
                    />
                  </span>
                ) : (
                  <>
                    <span className="font-medium">{t('web.conn.mismatch')}</span>
                    <span className="text-xs opacity-80">
                      <I18nTrans
                        components={{ code: <code /> }}
                        i18nKey="web.conn.versions"
                        values={{ daemon: check.result.daemonVersion, client: check.result.clientVersion }}
                      />
                    </span>
                    {check.result.reason && <span className="text-xs opacity-60">{check.result.reason}</span>}
                  </>
                )}
              </div>
            </div>
          )}

          <div className="flex items-center gap-2">
            <Button
              disabled={checking}
              onClick={() => void handleSave()}
            >
              {checking ? (
                <>
                  <HugeiconsIcon
                    className="animate-spin"
                    icon={LoaderPinwheelIcon}
                  />
                  {t('web.conn.checking')}
                </>
              ) : (
                t('web.conn.save')
              )}
            </Button>
            {isRemote && (
              <Button
                onClick={handleClear}
                variant="outline"
              >
                {t('web.conn.useLocal')}
              </Button>
            )}
          </div>

          <section className="flex flex-col gap-3">
            <h3 className="font-semibold text-sm">{t('web.settings.system.network')}</h3>
            <div className="overflow-hidden rounded-md border text-xs">
              <div className="grid grid-cols-[minmax(9rem,0.4fr)_minmax(0,1fr)] border-b">
                <div className="bg-muted px-3 py-2 text-muted-foreground">{t('web.conn.localEndpoint')}</div>
                <code className="min-w-0 break-all px-3 py-2 font-mono text-foreground">
                  {daemonScheme}://{daemonHost}:{network.settings?.port ?? 52749}
                </code>
              </div>
              <div className="grid grid-cols-[minmax(9rem,0.4fr)_minmax(0,1fr)]">
                <div className="bg-muted px-3 py-2 text-muted-foreground">
                  {t('web.settings.system.localHttpEndpoint')}
                </div>
                <code className="min-w-0 break-all px-3 py-2 font-mono text-foreground">
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
                    disabled={network.saving}
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
                disabled={network.loading || network.saving}
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
        </div>
      </ScrollArea>
    </div>
  );
}
