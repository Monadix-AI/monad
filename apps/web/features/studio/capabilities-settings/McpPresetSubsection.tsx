'use client';

import {
  CheckIcon,
  CheckmarkCircle02Icon,
  Download01Icon,
  GlobeIcon,
  LoaderPinwheelIcon,
  MonitorDotIcon,
  MonitorSpeakerIcon,
  Settings02Icon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { Badge, Button, Card, Input, Label, Switch } from '@monad/ui';
import { useEffect, useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useAsyncAction } from '@/hooks/use-async-action';
import { useBrowserPresetSettings } from '@/hooks/use-browser-preset-settings';
import { useComputerPresetSettings } from '@/hooks/use-computer-preset-settings';
import { useObscuraSettings } from '@/hooks/use-obscura-settings';

type McpPreset = 'browser' | 'computer' | 'obscura';

// MCP-backed runtime presets live with MCP so the Tools section only lists native built-in tools.
export function McpPresetSubsection() {
  const t = useT();
  const [openPreset, setOpenPreset] = useState<McpPreset | null>(null);

  return (
    <div className="flex flex-col gap-2">
      <div className="min-w-0">
        <p className="font-medium text-sm">{t('web.mcp.presets')}</p>
        <p className="mt-0.5 text-muted-foreground text-xs">{t('web.mcp.presetsHint')}</p>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-3">
        <BrowserPresetCard onConfigure={() => setOpenPreset('browser')} />
        <ComputerPresetCard onConfigure={() => setOpenPreset('computer')} />
        <ObscuraCard onConfigure={() => setOpenPreset('obscura')} />
      </div>

      <BrowserPresetDialog
        onClose={() => setOpenPreset(null)}
        open={openPreset === 'browser'}
      />
      <ComputerPresetDialog
        onClose={() => setOpenPreset(null)}
        open={openPreset === 'computer'}
      />
      <ObscuraDialog
        onClose={() => setOpenPreset(null)}
        open={openPreset === 'obscura'}
      />
    </div>
  );
}

function BrowserPresetCard({ onConfigure }: { onConfigure: () => void }) {
  const t = useT();
  const { config, save } = useBrowserPresetSettings();

  const summary = config?.enabled
    ? (config.engine ?? t('web.tools.browserEngineDefault'))
    : t('web.tools.browserDisabled');

  return (
    <PresetCard
      description={t('web.tools.browserPresetDesc')}
      enabled={config?.enabled ?? false}
      icon={MonitorSpeakerIcon}
      name={t('web.tools.browserPreset')}
      onConfigure={onConfigure}
      onToggle={(v) => void save({ enabled: v })}
      optional
      summary={summary}
    />
  );
}

function BrowserPresetDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const { config, save } = useBrowserPresetSettings();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();

  const [headless, setHeadless] = useState(true);
  const [vision, setVision] = useState(false);
  const [engine, setEngine] = useState<'chrome' | 'firefox' | 'webkit' | 'msedge' | ''>('');

  useEffect(() => {
    if (!open || !config) return;
    setHeadless(config.headless);
    setVision(config.vision);
    setEngine(config.engine ?? '');
  }, [open, config]);

  const handleSave = async () => {
    setSaving(true);
    setSaveError(undefined);
    try {
      await save({ headless, vision, engine: engine || null });
      onClose();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      open={open}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HugeiconsIcon
              className="size-4"
              icon={MonitorSpeakerIcon}
            />{' '}
            {t('web.tools.browserPreset')}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <label className="flex cursor-pointer items-center gap-2">
            <input
              checked={headless}
              className="size-4"
              onChange={(e) => setHeadless(e.target.checked)}
              type="checkbox"
            />
            <span className="text-sm">{t('web.tools.browserHeadless')}</span>
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <input
              checked={vision}
              className="size-4"
              onChange={(e) => setVision(e.target.checked)}
              type="checkbox"
            />
            <span className="text-sm">{t('web.tools.browserVision')}</span>
          </label>
          <div className="flex flex-col gap-1.5">
            <Label>{t('web.tools.browserEngine')}</Label>
            <div className="flex flex-wrap gap-2">
              {(['', 'chrome', 'firefox', 'webkit', 'msedge'] as const).map((e) => (
                <button
                  className={`rounded-md border px-3 py-1.5 text-sm ${engine === e ? 'border-ring bg-primary-subtle text-primary' : ''}`}
                  key={e || 'default'}
                  onClick={() => setEngine(e)}
                  type="button"
                >
                  {e || t('web.tools.browserEngineDefault')}
                </button>
              ))}
            </div>
          </div>
          <p className="text-muted-foreground text-xs">{t('web.tools.presetAppliesOnRestart')}</p>
          {saveError && <p className="text-destructive text-xs">{saveError}</p>}
          <div className="flex gap-2">
            <Button
              className="flex-1"
              disabled={saving}
              onClick={() => void handleSave()}
              size="sm"
            >
              {saving ? (
                <HugeiconsIcon
                  className="animate-spin"
                  icon={LoaderPinwheelIcon}
                />
              ) : (
                <HugeiconsIcon icon={CheckIcon} />
              )}
              {saving ? t('web.common.saving') : t('web.common.save')}
            </Button>
            <Button
              onClick={onClose}
              size="sm"
              variant="ghost"
            >
              {t('web.model.cancel')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ComputerPresetCard({ onConfigure }: { onConfigure: () => void }) {
  const t = useT();
  const { config, save } = useComputerPresetSettings();

  const summary = config?.enabled ? config.command : t('web.tools.computerDisabled');

  return (
    <PresetCard
      description={t('web.tools.computerPresetDesc')}
      enabled={config?.enabled ?? false}
      icon={MonitorDotIcon}
      name={t('web.tools.computerPreset')}
      onConfigure={onConfigure}
      onToggle={(v) => void save({ enabled: v })}
      optional
      summary={summary ?? t('web.tools.computerDisabled')}
    />
  );
}

function ComputerPresetDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const { config, save } = useComputerPresetSettings();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();

  const [command, setCommand] = useState('uvx');
  const [argsStr, setArgsStr] = useState('computer-control-mcp@latest');

  useEffect(() => {
    if (!open || !config) return;
    setCommand(config.command);
    setArgsStr(config.args.join(' '));
  }, [open, config]);

  const handleSave = async () => {
    setSaving(true);
    setSaveError(undefined);
    try {
      await save({
        command: command || 'uvx',
        args: argsStr
          .split(' ')
          .map((s) => s.trim())
          .filter(Boolean)
      });
      onClose();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      open={open}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HugeiconsIcon
              className="size-4"
              icon={MonitorDotIcon}
            />{' '}
            {t('web.tools.computerPreset')}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="computer-command">{t('web.tools.computerCommand')}</Label>
            <Input
              id="computer-command"
              onChange={(e) => setCommand(e.target.value)}
              placeholder="uvx"
              value={command}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="computer-args">{t('web.tools.computerArgs')}</Label>
            <Input
              id="computer-args"
              onChange={(e) => setArgsStr(e.target.value)}
              placeholder="computer-control-mcp@latest"
              value={argsStr}
            />
          </div>
          <p className="text-muted-foreground text-xs">{t('web.tools.presetAppliesOnRestart')}</p>
          {saveError && <p className="text-destructive text-xs">{saveError}</p>}
          <div className="flex gap-2">
            <Button
              className="flex-1"
              disabled={saving}
              onClick={() => void handleSave()}
              size="sm"
            >
              {saving ? (
                <HugeiconsIcon
                  className="animate-spin"
                  icon={LoaderPinwheelIcon}
                />
              ) : (
                <HugeiconsIcon icon={CheckIcon} />
              )}
              {saving ? t('web.common.saving') : t('web.common.save')}
            </Button>
            <Button
              onClick={onClose}
              size="sm"
              variant="ghost"
            >
              {t('web.model.cancel')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ObscuraCard({ onConfigure }: { onConfigure: () => void }) {
  const t = useT();
  const { status } = useObscuraSettings();

  const summary = status?.connected
    ? t('web.obscura.toolsLoaded', { count: status.tools.length })
    : status?.enabled
      ? t('web.obscura.connecting')
      : t('web.tools.computerDisabled');

  return (
    <PresetCard
      description={t('web.tools.obscuraDesc')}
      icon={GlobeIcon}
      name={t('web.tools.obscura')}
      onConfigure={onConfigure}
      summary={summary}
    />
  );
}

function ObscuraDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const { status, enable, disable, set } = useObscuraSettings();
  const { busy, run } = useAsyncAction();
  const [stealthLocal, setStealthLocal] = useState(false);

  useEffect(() => {
    if (open) setStealthLocal(status?.stealth ?? false);
  }, [open, status?.stealth]);

  return (
    <Dialog
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      open={open}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HugeiconsIcon
              className="size-4"
              icon={GlobeIcon}
            />{' '}
            {t('web.obscura.title')}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <p className="text-muted-foreground text-xs">{t('web.tools.obscuraDesc')}</p>

          {busy ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              {status?.enabled ? (
                <>
                  <HugeiconsIcon
                    className="size-4 animate-spin"
                    icon={LoaderPinwheelIcon}
                  />
                  {t('web.obscura.connecting')}
                </>
              ) : (
                <>
                  <HugeiconsIcon
                    className="size-4 animate-pulse"
                    icon={Download01Icon}
                  />
                  {t('web.obscura.downloading')}
                </>
              )}
            </div>
          ) : status?.connected ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-3">
                <Badge
                  className="gap-1 bg-success/15 text-success"
                  variant="secondary"
                >
                  <HugeiconsIcon
                    className="size-3"
                    icon={CheckmarkCircle02Icon}
                  />
                  {t('web.obscura.connected')}
                </Badge>
                <span className="text-muted-foreground text-xs">
                  {t('web.obscura.toolsLoaded', { count: status.tools.length })}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <input
                  checked={status.stealth}
                  className="size-4 cursor-pointer"
                  disabled={busy}
                  id="obscura-stealth"
                  onChange={(e) => run(() => set({ enabled: true, stealth: e.target.checked }))}
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
              <Button
                disabled={busy}
                onClick={() => run(disable)}
                size="sm"
                variant="outline"
              >
                {busy ? (
                  <HugeiconsIcon
                    className="animate-spin"
                    icon={LoaderPinwheelIcon}
                  />
                ) : null}
                {t('web.obscura.disable')}
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {!status?.installed ? (
                <p className="text-muted-foreground text-xs">{t('web.obscura.installNeeded')}</p>
              ) : (
                <p className="text-muted-foreground text-xs">{t('web.obscura.installed')}</p>
              )}
              <div className="flex items-center gap-2">
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
              </div>
              <Button
                className="self-start"
                disabled={busy}
                onClick={() => run(() => enable({ stealth: stealthLocal }))}
                size="sm"
              >
                {busy ? (
                  <HugeiconsIcon
                    className="animate-pulse"
                    icon={Download01Icon}
                  />
                ) : (
                  <HugeiconsIcon icon={Download01Icon} />
                )}
                {status?.installed ? t('web.obscura.enable') : t('web.obscura.downloadEnable')}
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PresetCard({
  description,
  enabled,
  icon: Icon,
  name,
  onConfigure,
  onToggle,
  optional,
  summary
}: {
  description: string;
  enabled?: boolean;
  icon: IconSvgElement;
  name: string;
  onConfigure: () => void;
  onToggle?: (v: boolean) => void;
  optional?: boolean;
  summary: string;
}) {
  return (
    <Card
      className="flex cursor-pointer flex-col gap-3 p-4 transition-colors hover:bg-muted/20"
      onClick={onConfigure}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="rounded-md bg-muted/50 p-1.5">
            <HugeiconsIcon
              className="size-4 text-foreground/70"
              icon={Icon}
            />
          </div>
          <span className="font-medium text-sm">{name}</span>
        </div>
        {optional && onToggle && (
          // biome-ignore lint/a11y/noStaticElementInteractions: prevents the switch click from opening the config card.
          <div
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            role="presentation"
          >
            <Switch
              checked={enabled ?? false}
              onCheckedChange={onToggle}
            />
          </div>
        )}
      </div>
      <p className="text-muted-foreground text-xs leading-relaxed">{description}</p>
      <div className="mt-auto flex items-center justify-between gap-2">
        <span className="truncate font-mono text-[11px] text-muted-foreground/60">{summary}</span>
        <HugeiconsIcon
          className="size-3.5 shrink-0 text-muted-foreground/40"
          icon={Settings02Icon}
        />
      </div>
    </Card>
  );
}
