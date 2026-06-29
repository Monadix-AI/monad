'use client';

import type { VersionCheckResult } from '@monad/client';
import type { GetHealthResponse } from '@monad/protocol';

import { zodResolver } from '@hookform/resolvers/zod';
import { checkDaemonVersion } from '@monad/client';
import { Button, Input, Label, Switch } from '@monad/ui';
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Globe,
  Loader2,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  X,
  XCircle
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';

import { I18nTrans, useT } from '@/components/I18nProvider';
import { useNetworkSettings } from '@/hooks/use-network-settings';
import { saveRemoteDaemonConnection } from '@/lib/daemon-connections';
import { daemonConnectionFormSchema } from '@/lib/form-validation';
import { useMonadRuntime } from '@/lib/monad-runtime-provider';
import { REMOTE_TOKEN_KEY, REMOTE_URL_KEY } from '@/lib/monad-store';
import { SECRET_INPUT_PASSWORD_MANAGER_PROPS } from './studio/ModelSettings/secret-input-props';

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
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [check, setCheck] = useState<CheckState>({ status: 'idle' });
  const [tlsWarning, setTlsWarning] = useState<'openssl' | 'cert-error' | null>(null);
  const [certFp, setCertFp] = useState<CertFpState | null>(null);
  const [daysUntilExpiry, setDaysUntilExpiry] = useState<number | null>(null);
  const [networkCopied, setNetworkCopied] = useState(false);
  const network = useNetworkSettings();
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

  async function toggleAllowInsecureHttp(allowInsecureHttp: boolean) {
    await network.set({ remoteAccess: { allowInsecureHttp } });
  }

  async function rotateRemoteToken() {
    await network.set({ remoteAccess: { rotateToken: true } });
    setNetworkCopied(false);
  }

  async function copyRemoteToken() {
    const remoteToken = network.settings?.remoteAccess.token;
    if (!remoteToken) return;
    await navigator.clipboard.writeText(remoteToken);
    setNetworkCopied(true);
    setTimeout(() => setNetworkCopied(false), 1500);
  }

  const isRemote = !!localStorage.getItem(REMOTE_URL_KEY)?.trim();
  const checking = check.status === 'checking';
  const remoteAccess = network.settings?.remoteAccess;
  const remoteAccessEnabled = remoteAccess?.enabled ?? false;
  const localScheme = remoteAccessEnabled && !remoteAccess?.allowInsecureHttp ? 'https' : 'http';

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b px-6 py-4">
        <div className="flex items-center gap-2">
          <Globe className="size-4 text-muted-foreground" />
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
          <X />
        </Button>
      </div>

      <div className="flex flex-1 flex-col gap-6 px-6 py-6">
        <p className="text-muted-foreground text-sm">{t('web.conn.intro')}</p>

        <section className="flex flex-col gap-3 rounded-md border bg-muted/20 px-3 py-3">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-1">
              <span className="font-medium text-sm">{t('web.conn.localRemoteTitle')}</span>
              <span className="text-muted-foreground text-xs">{t('web.conn.localRemoteDesc')}</span>
            </div>
            <Switch
              aria-label={t('web.conn.localRemoteTitle')}
              checked={remoteAccessEnabled}
              disabled={network.loading || network.saving}
              onCheckedChange={(checked) => void toggleRemoteAccess(checked)}
            />
          </div>

          {network.loading ? (
            <div className="flex items-center gap-2 text-muted-foreground text-xs">
              <Loader2 className="size-3.5 animate-spin" />
              {t('web.common.loading')}
            </div>
          ) : (
            <>
              <div className="grid gap-2 text-xs sm:grid-cols-2">
                <div className="rounded border bg-background px-2.5 py-2">
                  <div className="text-muted-foreground">{t('web.conn.localEndpoint')}</div>
                  <code className="font-mono text-foreground">
                    {localScheme}://127.0.0.1:{network.settings?.port ?? 52749}
                  </code>
                </div>
                <div className="rounded border bg-background px-2.5 py-2">
                  <div className="text-muted-foreground">{t('web.conn.localTransport')}</div>
                  <code className="font-mono text-foreground">{network.settings?.transport ?? 'tcp'}</code>
                </div>
              </div>

              {remoteAccessEnabled && (
                <div className="flex flex-col gap-2">
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
                      value={remoteAccess?.token ?? ''}
                      {...SECRET_INPUT_PASSWORD_MANAGER_PROPS}
                    />
                    <Button
                      aria-label={t('web.conn.copyToken')}
                      disabled={!remoteAccess?.token}
                      onClick={() => void copyRemoteToken()}
                      size="icon"
                      variant="outline"
                    >
                      <Copy className={networkCopied ? 'text-success' : undefined} />
                    </Button>
                    <Button
                      aria-label={t('web.conn.rotateToken')}
                      disabled={network.saving}
                      onClick={() => void rotateRemoteToken()}
                      size="icon"
                      variant="outline"
                    >
                      <RotateCcw />
                    </Button>
                  </div>
                </div>
              )}

              <div className="flex items-start justify-between gap-4 rounded border bg-background px-2.5 py-2">
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-xs">{t('web.conn.allowInsecureHttp')}</span>
                  <span className="text-[11px] text-muted-foreground">{t('web.conn.allowInsecureHttpDesc')}</span>
                </span>
                <Switch
                  aria-label={t('web.conn.allowInsecureHttp')}
                  checked={remoteAccess?.allowInsecureHttp ?? false}
                  disabled={network.loading || network.saving}
                  onCheckedChange={(checked) => void toggleAllowInsecureHttp(checked)}
                />
              </div>

              {network.settings?.restartRequired && (
                <div className="flex items-start gap-2 rounded border border-warning/30 bg-warning/5 px-2.5 py-2 text-warning text-xs">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  <span>{t('web.conn.restartRequired')}</span>
                </div>
              )}
            </>
          )}

          {network.error && <div className="text-destructive text-xs">{network.error}</div>}
        </section>

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
              placeholder="http://192.168.1.100:52749"
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
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
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
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
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
              <ShieldAlert className="mt-0.5 size-4 shrink-0" />
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
                <ShieldCheck className="size-3.5 text-success" />
              ) : (
                <ShieldCheck className="size-3.5 text-muted-foreground" />
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
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
            ) : (
              <XCircle className="mt-0.5 size-4 shrink-0" />
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
                <Loader2 className="animate-spin" />
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
      </div>
    </div>
  );
}
