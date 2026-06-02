'use client';

import { Badge, Button, cn, Label, ScrollArea } from '@monad/ui';
import { CheckCircle2, Download, Loader2, RefreshCw } from 'lucide-react';
import { useState } from 'react';

import { type TFn, useT } from '@/components/I18nProvider';
import { useAsyncAction } from '../hooks/use-async-action';
import { useObscuraSettings } from '../hooks/use-obscura-settings';
import { StudioPanel, StudioPanelHeader } from './studio/StudioPanel';

export function ObscuraSettings(_props: { onClose: () => void }) {
  const t = useT();
  const { status, loading, enable, disable, set, refetch } = useObscuraSettings();
  const { busy, run } = useAsyncAction();

  return (
    <StudioPanel>
      <StudioPanelHeader
        actions={
          <Button
            aria-label={t('web.common.refresh')}
            className="size-7"
            onClick={refetch}
            size="icon"
            variant="ghost"
          >
            <RefreshCw className={cn(loading && 'animate-spin')} />
          </Button>
        }
        subtitle={t('web.obscura.subtitle')}
        title={t('web.obscura.title')}
      />

      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-4 p-5">
          <p className="text-muted-foreground text-xs">
            Obscura is a Rust-based headless browser with a built-in MCP server (12 browser tools). It handles
            JS-rendered pages and interactive scenarios that <code>web_extract</code> cannot reach. The binary is
            downloaded from GitHub on first enable and reused across restarts.
          </p>

          {loading ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <Loader2 className="size-4 animate-spin" />
              {t('web.common.loading')}
            </div>
          ) : busy ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <Download className="size-4 animate-pulse" />
              {status?.enabled ? t('web.obscura.connecting') : t('web.obscura.downloading')}
            </div>
          ) : status?.connected ? (
            <ConnectedView
              busy={busy}
              onDisable={() => run(disable)}
              onStealth={(v) => run(() => set({ enabled: true, stealth: v }))}
              status={status}
              t={t}
            />
          ) : (
            <DisabledView
              busy={busy}
              installed={status?.installed ?? false}
              onEnable={(stealth) => run(() => enable({ stealth }))}
              stealth={status?.stealth ?? false}
              t={t}
            />
          )}
        </div>
      </ScrollArea>
    </StudioPanel>
  );
}

function ConnectedView({
  status,
  onDisable,
  onStealth,
  busy,
  t
}: {
  status: { tools: string[]; stealth: boolean };
  onDisable: () => void;
  onStealth: (v: boolean) => void;
  busy: boolean;
  t: TFn;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Badge
          className="gap-1 bg-success/15 text-success"
          variant="secondary"
        >
          <CheckCircle2 className="size-3" />
          {t('web.obscura.connected')}
        </Badge>
        <span className="text-muted-foreground text-xs">
          {t('web.obscura.toolsLoaded', { count: status.tools.length })}
        </span>
      </div>

      <div className="flex items-center gap-3">
        <input
          checked={status.stealth}
          className="size-4 cursor-pointer"
          disabled={busy}
          id="obscura-stealth"
          onChange={(e) => onStealth(e.target.checked)}
          type="checkbox"
        />
        <Label
          className="text-sm"
          htmlFor="obscura-stealth"
        >
          {t('web.obscura.stealthMode')}
        </Label>
        <span className="text-muted-foreground text-xs">{t('web.obscura.stealthDesc')}</span>
      </div>

      <div className="rounded-md border p-3">
        <p className="mb-2 text-muted-foreground text-xs">{t('web.obscura.availableTools')}</p>
        <div className="flex flex-wrap gap-1">
          {status.tools.map((tool) => (
            <Badge
              className="font-mono text-[10px]"
              key={tool}
              variant="secondary"
            >
              {tool}
            </Badge>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <Button
          disabled={busy}
          onClick={onDisable}
          size="sm"
          variant="outline"
        >
          {busy ? <Loader2 className="animate-spin" /> : null}
          {t('web.obscura.disable')}
        </Button>
        <p className="text-muted-foreground text-xs">{t('web.obscura.disableHint')}</p>
      </div>
    </div>
  );
}

function DisabledView({
  stealth,
  installed,
  onEnable,
  busy,
  t
}: {
  stealth: boolean;
  installed: boolean;
  onEnable: (stealth: boolean) => void;
  busy: boolean;
  t: TFn;
}) {
  const [stealthLocal, setStealthLocal] = useState(stealth);

  return (
    <div className="flex flex-col gap-4">
      {!installed ? (
        <p className="text-muted-foreground text-xs">{t('web.obscura.installNeeded')}</p>
      ) : (
        <p className="text-muted-foreground text-xs">{t('web.obscura.installed')}</p>
      )}

      <div className="flex items-center gap-3">
        <input
          checked={stealthLocal}
          className="size-4 cursor-pointer"
          disabled={busy}
          id="obscura-stealth-pre"
          onChange={(e) => setStealthLocal(e.target.checked)}
          type="checkbox"
        />
        <Label
          className="text-sm"
          htmlFor="obscura-stealth-pre"
        >
          {t('web.obscura.stealthMode')}
        </Label>
        <span className="text-muted-foreground text-xs">{t('web.obscura.stealthDesc')}</span>
      </div>

      <Button
        className="self-start"
        disabled={busy}
        onClick={() => onEnable(stealthLocal)}
        size="sm"
      >
        {busy ? <Download className="animate-pulse" /> : <Download />}
        {installed ? t('web.obscura.enable') : t('web.obscura.downloadEnable')}
      </Button>
    </div>
  );
}
