'use client';

import type { ActivateSandboxBackendRequest, SetSandboxSettingsRequest } from '@monad/protocol';

import { CheckIcon, LoaderPinwheelIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useActivateSandboxMutation, useGetSandboxQuery, useSetSandboxMutation } from '@monad/client-rtk';
import {
  Button,
  Label,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch
} from '@monad/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { BackendCards, backendRefKey } from './sandbox/BackendCards';
import { SchemaSettingsForm } from './sandbox/SchemaSettingsForm';

type Mode = 'workspace' | 'home' | 'unrestricted' | 'ephemeral';
type Net = 'none' | 'unrestricted' | 'filtered';
type HostExec = 'deny' | 'ask' | 'allow';

const MODES: Mode[] = ['workspace', 'home', 'unrestricted', 'ephemeral'];
const NETS: Net[] = ['none', 'unrestricted', 'filtered'];
const HOST_EXECS: HostExec[] = ['deny', 'ask', 'allow'];

function SandboxDefaultsSkeleton() {
  return (
    <ScrollArea className="flex-1">
      <div
        aria-busy="true"
        className="mx-auto flex max-w-2xl flex-col gap-6 p-5"
      >
        <header className="flex flex-col gap-2">
          <Skeleton className="h-5 w-44 rounded" />
          <Skeleton className="h-4 w-4/5 rounded" />
        </header>
        {Array.from({ length: 2 }, (_, section) => `sandbox-section-${section}`).map((key) => (
          <section
            className="flex flex-col gap-1"
            key={key}
          >
            <Skeleton className="mb-1 h-3 w-28 rounded" />
            <div className="divide-y rounded-lg border px-3">
              {Array.from({ length: 4 }, (_, row) => `${key}-row-${row}`).map((rowKey) => (
                <div
                  className="flex items-center justify-between gap-4 py-2.5"
                  key={rowKey}
                >
                  <div className="flex flex-col gap-1.5">
                    <Skeleton className="h-4 w-32 rounded" />
                    <Skeleton className="h-3 w-52 rounded" />
                  </div>
                  <Skeleton className="h-8 w-44 rounded-md" />
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </ScrollArea>
  );
}

/** Studio › Capabilities › Sandbox: the system-level sandbox defaults (cfg.agent.sandbox) + the global
 *  ceiling (cfg.agent.globalSandbox). Per-agent sandbox overrides narrow within these; the ceiling, when
 *  enabled, forces every agent to its mode. Boot-time confinement applies on the next daemon restart. */
export function SandboxDefaults() {
  const t = useT();
  const { data, isLoading } = useGetSandboxQuery();
  const [setSandbox] = useSetSandboxMutation();
  const [activateSandbox, activation] = useActivateSandboxMutation();

  const [mode, setMode] = useState<Mode>('workspace');
  const [confine, setConfine] = useState(true);
  const [net, setNet] = useState<Net>('unrestricted');
  const [allowedDomains, setAllowedDomains] = useState('');
  const [hostExec, setHostExec] = useState<HostExec>('ask');
  const [globalEnabled, setGlobalEnabled] = useState(false);
  const [globalMode, setGlobalMode] = useState<Mode>('workspace');

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();
  const [selectedBackendKey, setSelectedBackendKey] = useState<string>();
  const [activationSettings, setActivationSettings] = useState<ActivateSandboxBackendRequest['settings']>();
  const selectedBackend = useMemo(
    () => data?.backends.find((backend) => backendRefKey(backend) === selectedBackendKey),
    [data?.backends, selectedBackendKey]
  );
  const updateActivationSettings = useCallback(
    (settings: NonNullable<ActivateSandboxBackendRequest['settings']>) => setActivationSettings(settings),
    []
  );

  useEffect(() => {
    if (!data) return;
    setMode(data.sandbox.mode as Mode);
    setConfine(data.sandbox.confine);
    setNet(data.sandbox.net);
    setAllowedDomains(data.sandbox.allowedDomains.join('\n'));
    setHostExec(data.sandbox.hostExec);
    setGlobalEnabled(data.globalSandbox.enabled);
    setGlobalMode(data.globalSandbox.mode as Mode);
    const preferredBackend = data.backends.find((backend) => backend.status === 'active') ?? data.backends[0];
    if (preferredBackend) setSelectedBackendKey((current) => current ?? backendRefKey(preferredBackend));
  }, [data]);

  const handleActivate = async () => {
    if (!selectedBackend) return;
    setError(undefined);
    try {
      const result = await activateSandbox({ ref: selectedBackend.ref, settings: activationSettings }).unwrap();
      if (result.status === 'error') setError(result.error ?? 'Failed to activate sandbox backend');
    } catch (cause) {
      setError((cause as { message?: string }).message ?? 'Failed to activate sandbox backend');
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    setError(undefined);
    const req: SetSandboxSettingsRequest = {
      sandbox: {
        mode,
        confine,
        net,
        allowedDomains: allowedDomains
          .split('\n')
          .map((d) => d.trim())
          .filter(Boolean),
        hostExec
      },
      globalSandbox: { enabled: globalEnabled, mode: globalMode }
    };
    try {
      await setSandbox(req).unwrap();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError((e as { message?: string }).message ?? 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  if (isLoading) return <SandboxDefaultsSkeleton />;

  const enumSelect = <T extends string>(value: T, onChange: (v: T) => void, options: readonly T[]) => (
    <Select
      onValueChange={(v) => onChange(v as T)}
      value={value}
    >
      <SelectTrigger className="w-44">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem
            key={o}
            value={o}
          >
            {o}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  const rowClass = 'flex items-center justify-between gap-4 py-2.5';

  return (
    <ScrollArea className="flex-1">
      <div className="mx-auto flex max-w-2xl flex-col gap-6 p-5">
        <header className="flex flex-col gap-1">
          <h2 className="font-medium text-base">{t('web.studio.sandboxTitle')}</h2>
          <p className="text-muted-foreground text-sm">{t('web.studio.sandboxDesc')}</p>
        </header>

        <section className="flex flex-col gap-3">
          <div>
            <p className="font-medium text-sm">Sandbox backend</p>
            <p className="text-muted-foreground text-xs">Switch new processes without restarting the daemon.</p>
          </div>
          <BackendCards
            backends={data?.backends ?? []}
            onSelect={(backend) => setSelectedBackendKey(backendRefKey(backend))}
            selectedKey={selectedBackendKey}
          />
          {selectedBackend?.descriptor.settings?.fields.length ? (
            <SchemaSettingsForm
              backend={selectedBackend}
              onChange={updateActivationSettings}
            />
          ) : null}
          {selectedBackend && (
            <div className="flex items-center gap-3">
              <Button
                disabled={activation.isLoading}
                onClick={handleActivate}
              >
                {activation.isLoading
                  ? 'Preparing…'
                  : selectedBackend.status === 'active'
                    ? 'Apply settings'
                    : 'Activate'}
              </Button>
              <span className="text-muted-foreground text-xs">
                {selectedBackend.sourceLabel} · {selectedBackend.status}
              </span>
            </div>
          )}
        </section>

        <section className="flex flex-col gap-1">
          <p className="pb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
            {t('web.studio.sandboxDefaultGroup')}
          </p>
          <div className="divide-y rounded-lg border px-3">
            <div className={rowClass}>
              <Label>{t('web.studio.sandboxMode')}</Label>
              {enumSelect(mode, setMode, MODES)}
            </div>
            <div className={rowClass}>
              <div className="flex flex-col gap-0.5">
                <Label>{t('web.studio.sandboxConfine')}</Label>
                <p className="text-[11px] text-muted-foreground">{t('web.studio.sandboxConfineHint')}</p>
              </div>
              <Switch
                checked={confine}
                onCheckedChange={setConfine}
              />
            </div>
            <div className={rowClass}>
              <Label>{t('web.studio.sandboxNet')}</Label>
              {enumSelect(net, setNet, NETS)}
            </div>
            {net === 'filtered' && (
              <div className="flex flex-col gap-1.5 py-2.5">
                <Label htmlFor="sandbox-domains">{t('web.studio.sandboxAllowedDomains')}</Label>
                <textarea
                  className="min-h-[64px] w-full resize-y rounded-md border bg-transparent px-3 py-2 font-mono text-xs"
                  id="sandbox-domains"
                  onChange={(e) => setAllowedDomains(e.target.value)}
                  placeholder={t('web.studio.domainPlaceholder')}
                  value={allowedDomains}
                />
                <p className="text-[11px] text-muted-foreground">{t('web.studio.sandboxAllowedDomainsHint')}</p>
              </div>
            )}
            <div className={rowClass}>
              <div className="flex flex-col gap-0.5">
                <Label>{t('web.studio.sandboxHostExec')}</Label>
                <p className="text-[11px] text-muted-foreground">{t('web.studio.sandboxHostExecHint')}</p>
              </div>
              {enumSelect(hostExec, setHostExec, HOST_EXECS)}
            </div>
          </div>
        </section>

        <section className="flex flex-col gap-1">
          <p className="pb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
            {t('web.studio.sandboxGlobalGroup')}
          </p>
          <div className="divide-y rounded-lg border px-3">
            <div className={rowClass}>
              <div className="flex flex-col gap-0.5">
                <Label>{t('web.studio.sandboxGlobalEnabled')}</Label>
                <p className="text-[11px] text-muted-foreground">{t('web.studio.sandboxGlobalEnabledHint')}</p>
              </div>
              <Switch
                checked={globalEnabled}
                onCheckedChange={setGlobalEnabled}
              />
            </div>
            {globalEnabled && (
              <div className={rowClass}>
                <Label>{t('web.studio.sandboxMode')}</Label>
                {enumSelect(globalMode, setGlobalMode, MODES)}
              </div>
            )}
          </div>
        </section>

        <div className="flex items-center gap-3">
          <Button
            disabled={saving}
            onClick={handleSave}
          >
            {saving ? (
              <HugeiconsIcon
                className="size-3.5 animate-spin"
                icon={LoaderPinwheelIcon}
              />
            ) : (
              t('web.common.save')
            )}
          </Button>
          {saved && (
            <span className="flex items-center gap-1 text-muted-foreground text-xs">
              <HugeiconsIcon
                className="size-3.5 text-primary"
                icon={CheckIcon}
              />
              {t('web.studio.sandboxSaved')}
            </span>
          )}
          {error && <span className="text-destructive text-xs">{error}</span>}
        </div>

        <p className="text-[11px] text-muted-foreground">{t('web.studio.sandboxRestartHint')}</p>
      </div>
    </ScrollArea>
  );
}
