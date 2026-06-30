'use client';

import type { SetToolBackendsRequest, SmtpSettings } from '@monad/protocol';

import { useInitDockerBackendMutation } from '@monad/client-rtk';
import { Badge, Button, Card, Input, Label, ScrollArea, Switch } from '@monad/ui';
import {
  Brain,
  CalendarClock,
  Check,
  CheckCircle2,
  Code2,
  Cpu,
  Download,
  FileSearch,
  FolderOpen,
  Globe,
  Loader2,
  Mail,
  Monitor,
  MonitorPlay,
  Network,
  RefreshCw,
  Settings2,
  SquareCheckBig,
  Terminal
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useBrowserPresetSettings } from '@/hooks/use-browser-preset-settings';
import { useComputerPresetSettings } from '@/hooks/use-computer-preset-settings';
import { useToolBackendsSettings } from '@/hooks/use-tool-backends-settings';
import { useAsyncAction } from '../../hooks/use-async-action';
import { useObscuraSettings } from '../../hooks/use-obscura-settings';
import { CapabilitySection } from './CapabilitySection';

// The Tools half of the Capabilities panel: built-in tool cards. Core tools are always on; the
// optional ones (email, browser/computer presets) toggle. Tools cannot be added — only MCP can.
export function ToolsSection() {
  const { config, loading, save, refetch } = useToolBackendsSettings();
  const [initDocker, { isLoading: dockerInitializing }] = useInitDockerBackendMutation();
  const t = useT();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [dockerInitResult, setDockerInitResult] = useState<{ ok: boolean; error?: string } | null>(null);

  const [wsProvider, setWsProvider] = useState<'auto' | 'native' | 'brave' | 'ddgs'>('auto');
  const [braveApiKey, setBraveApiKey] = useState('');

  type CodeExecBackend = 'follow-system' | 'docker' | 'e2b';
  const [codeExecBackend, setCodeExecBackend] = useState<CodeExecBackend>('follow-system');
  const [availableCodeExecBackends, setAvailableCodeExecBackends] = useState<string[]>(['follow-system']);
  const [e2bApiKey, setE2bApiKey] = useState('');
  const [dockerImage, setDockerImage] = useState('');

  const [emailEnabled, setEmailEnabled] = useState(false);
  const [emailBackend, setEmailBackend] = useState<'auto' | 'smtp' | 'resend'>('auto');
  const [emailFrom, setEmailFrom] = useState('');
  const [resendApiKey, setResendApiKey] = useState('');
  const [smtpEnabled, setSmtpEnabled] = useState(false);
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('');
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPass, setSmtpPass] = useState('');
  const [smtpSecure, setSmtpSecure] = useState(false);
  const [smtpClientName, setSmtpClientName] = useState('');

  const [openTool, setOpenTool] = useState<
    'webSearch' | 'codeExec' | 'email' | 'browser' | 'computer' | 'obscura' | null
  >(null);

  // Shared SMTP→state hydration used by both the initial load and the dialog cancel/reset path.
  // useCallback (over stable setters) keeps it out of effect-dependency churn.
  const applyEmailConfig = useCallback((cfg: NonNullable<typeof config>) => {
    setEmailBackend(cfg.email.backend);
    setEmailFrom(cfg.email.from ?? '');
    setResendApiKey(cfg.email.resendApiKey ?? '');
    if (cfg.email.smtp) {
      setSmtpEnabled(true);
      setSmtpHost(cfg.email.smtp.host);
      setSmtpPort(cfg.email.smtp.port?.toString() ?? '');
      setSmtpUser(cfg.email.smtp.user ?? '');
      setSmtpPass(cfg.email.smtp.pass ?? '');
      setSmtpSecure(cfg.email.smtp.secure ?? false);
      setSmtpClientName(cfg.email.smtp.clientName ?? '');
    } else {
      setSmtpEnabled(false);
    }
  }, []);

  useEffect(() => {
    if (!config) return;
    setWsProvider(config.webSearch.provider);
    setBraveApiKey(config.webSearch.braveApiKey ?? '');
    const b = config.codeExec.backend;
    setCodeExecBackend((b === 'local' ? 'follow-system' : b) as CodeExecBackend);
    setAvailableCodeExecBackends(config.codeExec.availableBackends);
    setE2bApiKey(config.codeExec.e2bApiKey ?? '');
    setDockerImage(config.codeExec.dockerImage ?? '');
    const hasEmailConfig = !!(config.email.from || config.email.smtp || config.email.resendApiKey);
    setEmailEnabled(hasEmailConfig);
    applyEmailConfig(config);
  }, [config, applyEmailConfig]);

  const resetFromConfig = (tool: 'webSearch' | 'codeExec' | 'email') => {
    if (!config) return;
    if (tool === 'webSearch') {
      setWsProvider(config.webSearch.provider);
      setBraveApiKey(config.webSearch.braveApiKey ?? '');
    } else if (tool === 'codeExec') {
      const b = config.codeExec.backend;
      setCodeExecBackend((b === 'local' ? 'follow-system' : b) as CodeExecBackend);
      setE2bApiKey(config.codeExec.e2bApiKey ?? '');
      setDockerImage(config.codeExec.dockerImage ?? '');
    } else {
      applyEmailConfig(config);
    }
  };

  const handleSave = async (overrides?: { emailEnabled?: boolean }) => {
    setSaving(true);
    setSaveError(undefined);
    const effectiveEmailEnabled = overrides?.emailEnabled ?? emailEnabled;
    try {
      const smtp: SmtpSettings | null =
        effectiveEmailEnabled && smtpEnabled && smtpHost
          ? {
              host: smtpHost,
              port: smtpPort ? parseInt(smtpPort, 10) : undefined,
              user: smtpUser || undefined,
              pass: smtpPass || undefined,
              secure: smtpSecure || undefined,
              clientName: smtpClientName || undefined
            }
          : null;

      const req: SetToolBackendsRequest = {
        webSearch: { provider: wsProvider, braveApiKey: braveApiKey || undefined },
        email: effectiveEmailEnabled
          ? { backend: emailBackend, from: emailFrom || undefined, resendApiKey: resendApiKey || undefined, smtp }
          : { backend: 'auto', from: undefined, resendApiKey: undefined, smtp: null },
        codeExec: {
          backend: codeExecBackend,
          e2bApiKey: e2bApiKey || null,
          dockerImage: dockerImage || null
        }
      };
      await save(req);
      setOpenTool(null);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const wsProviderLabel =
    wsProvider === 'ddgs'
      ? 'DuckDuckGo'
      : wsProvider === 'brave'
        ? 'Brave'
        : wsProvider === 'native'
          ? t('web.tools.searchProviderNative')
          : t('web.tools.searchProviderAuto');

  const codeExecLabel =
    codeExecBackend === 'docker'
      ? t('web.tools.dockerBackend')
      : codeExecBackend === 'e2b'
        ? t('web.tools.e2bBackend')
        : t('web.tools.followSystemBackend');

  const emailSummary = !emailEnabled
    ? t('web.tools.emailDisabled')
    : emailFrom
      ? emailFrom
      : emailBackend === 'smtp'
        ? 'SMTP'
        : emailBackend === 'resend'
          ? 'Resend'
          : t('web.tools.searchProviderAuto');

  return (
    <>
      <CapabilitySection
        actions={
          <Button
            aria-label={t('web.common.refresh')}
            className="size-7"
            onClick={refetch}
            size="icon"
            variant="ghost"
          >
            <RefreshCw className={loading ? 'animate-spin' : ''} />
          </Button>
        }
        subtitle={t('web.studio.capabilitiesToolsSubtitle')}
        title={t('web.studio.capabilitiesToolsSection')}
      >
        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Loader2 className="size-4 animate-spin" />
            {t('web.common.loading')}
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-3">
            <ToolCard
              description={t('web.tools.webSearchDesc')}
              icon={Globe}
              name={t('web.tools.searchTool')}
              onConfigure={() => setOpenTool('webSearch')}
              summary={wsProviderLabel}
            />
            <ToolCard
              description={t('web.tools.codeExecDesc')}
              icon={Code2}
              name={t('web.tools.codeExec')}
              onConfigure={() => setOpenTool('codeExec')}
              summary={codeExecLabel}
            />
            <ToolCard
              description={t('web.tools.emailDesc')}
              enabled={emailEnabled}
              icon={Mail}
              name={t('web.tools.email')}
              onConfigure={() => setOpenTool('email')}
              onToggle={(v) => {
                setEmailEnabled(v);
                if (!v) void handleSave({ emailEnabled: false });
              }}
              optional
              summary={emailSummary}
            />
            <BrowserPresetCard onConfigure={() => setOpenTool('browser')} />
            <ComputerPresetCard onConfigure={() => setOpenTool('computer')} />
            <ObscuraCard onConfigure={() => setOpenTool('obscura')} />
            <ToolCard
              description={t('web.tools.filesystemDesc')}
              icon={FolderOpen}
              name={t('web.tools.filesystem')}
              summary={t('web.tools.alwaysOn')}
            />
            <ToolCard
              description={t('web.tools.shellDesc')}
              icon={Terminal}
              name={t('web.tools.shell')}
              summary={t('web.tools.alwaysOn')}
            />
            <ToolCard
              description={t('web.tools.processDesc')}
              icon={Cpu}
              name={t('web.tools.process')}
              summary={t('web.tools.alwaysOn')}
            />
            <ToolCard
              description={t('web.tools.networkDesc')}
              icon={Network}
              name={t('web.tools.network')}
              summary={t('web.tools.alwaysOn')}
            />
            <ToolCard
              description={t('web.tools.webExtractDesc')}
              icon={FileSearch}
              name={t('web.tools.webExtract')}
              summary={t('web.tools.alwaysOn')}
            />
            <ToolCard
              description={t('web.tools.todoDesc')}
              icon={SquareCheckBig}
              name={t('web.tools.todo')}
              summary={t('web.tools.alwaysOn')}
            />
            <ToolCard
              description={t('web.tools.memoryDesc')}
              icon={Brain}
              name={t('web.tools.memory')}
              summary={t('web.tools.alwaysOn')}
            />
            <ToolCard
              description={t('web.tools.scheduleDesc')}
              icon={CalendarClock}
              name={t('web.tools.schedule')}
              summary={t('web.tools.alwaysOn')}
            />
          </div>
        )}
      </CapabilitySection>

      {/* Web Search dialog */}
      <Dialog
        onOpenChange={(o) => {
          if (!o) {
            resetFromConfig('webSearch');
            setOpenTool(null);
            setSaveError(undefined);
          }
        }}
        open={openTool === 'webSearch'}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Globe className="size-4" /> {t('web.tools.searchTool')}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label>{t('web.tools.searchProviderLabel')}</Label>
              <div className="flex flex-wrap gap-2">
                {(['auto', 'native', 'ddgs', 'brave'] as const).map((p) => (
                  <button
                    className={`rounded-md border px-3 py-1.5 text-sm ${wsProvider === p ? 'border-ring bg-primary-subtle text-primary' : ''}`}
                    key={p}
                    onClick={() => setWsProvider(p)}
                    type="button"
                  >
                    {p === 'auto'
                      ? t('web.tools.searchProviderAuto')
                      : p === 'native'
                        ? t('web.tools.searchProviderNative')
                        : p === 'ddgs'
                          ? 'DuckDuckGo'
                          : 'Brave'}
                  </button>
                ))}
              </div>
              <p className="text-muted-foreground text-xs">
                {wsProvider === 'native'
                  ? t('web.tools.wsNative')
                  : wsProvider === 'brave'
                    ? t('web.tools.wsBrave')
                    : wsProvider === 'ddgs'
                      ? t('web.tools.wsDdgs')
                      : t('web.tools.wsAuto')}
              </p>
            </div>
            {wsProvider === 'brave' && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="brave-api-key">{t('web.tools.braveApiKey')}</Label>
                <Input
                  id="brave-api-key"
                  onChange={(e) => setBraveApiKey(e.target.value)}
                  placeholder="BSA… or ${env:BRAVE_API_KEY}"
                  value={braveApiKey}
                />
              </div>
            )}
            {saveError && <p className="text-destructive text-xs">{saveError}</p>}
            <div className="flex gap-2">
              <Button
                className="flex-1"
                disabled={saving}
                onClick={() => void handleSave()}
                size="sm"
              >
                {saving ? <Loader2 className="animate-spin" /> : <Check />}
                {saving ? t('web.common.saving') : t('web.common.save')}
              </Button>
              <Button
                onClick={() => {
                  resetFromConfig('webSearch');
                  setOpenTool(null);
                  setSaveError(undefined);
                }}
                size="sm"
                variant="ghost"
              >
                {t('web.model.cancel')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Code Execution dialog */}
      <Dialog
        onOpenChange={(o) => {
          if (o) {
            refetch();
            setDockerInitResult(null);
          } else {
            resetFromConfig('codeExec');
            setOpenTool(null);
            setSaveError(undefined);
            setDockerInitResult(null);
          }
        }}
        open={openTool === 'codeExec'}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Code2 className="size-4" /> {t('web.tools.codeExec')}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label>{t('web.tools.sandboxLabel')}</Label>
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    { id: 'follow-system', label: t('web.tools.followSystemBackend') },
                    { id: 'docker', label: t('web.tools.dockerBackend') },
                    { id: 'e2b', label: t('web.tools.e2bBackend') }
                  ] as const
                ).map(({ id, label }) => {
                  const available = availableCodeExecBackends.includes(id);
                  const unavailableHint =
                    id === 'docker'
                      ? t('web.tools.dockerInstallHint')
                      : id === 'e2b'
                        ? t('web.tools.e2bNotAvailable')
                        : undefined;
                  return (
                    <button
                      className={`rounded-md border px-3 py-1.5 text-sm transition-opacity ${codeExecBackend === id ? 'border-ring bg-primary-subtle text-primary' : ''} ${!available ? 'cursor-not-allowed opacity-40' : ''}`}
                      disabled={!available}
                      key={id}
                      onClick={() => available && setCodeExecBackend(id)}
                      title={!available ? unavailableHint : undefined}
                      type="button"
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              <p className="text-muted-foreground text-xs">
                {codeExecBackend === 'docker'
                  ? t('web.tools.dockerDesc')
                  : codeExecBackend === 'e2b'
                    ? t('web.tools.e2bDesc')
                    : t('web.tools.followSystemDesc')}
              </p>
            </div>

            {codeExecBackend === 'e2b' && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="e2b-api-key">{t('web.tools.e2bApiKey')}</Label>
                <Input
                  id="e2b-api-key"
                  onChange={(e) => setE2bApiKey(e.target.value)}
                  placeholder={t('web.tools.e2bApiKeyPlaceholder')}
                  value={e2bApiKey}
                />
              </div>
            )}

            {codeExecBackend === 'docker' && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="docker-image">{t('web.tools.dockerImageLabel')}</Label>
                <Input
                  id="docker-image"
                  onChange={(e) => setDockerImage(e.target.value)}
                  placeholder={t('web.tools.dockerImagePlaceholder')}
                  value={dockerImage}
                />
                <div className="flex items-center gap-2">
                  <Button
                    disabled={dockerInitializing}
                    onClick={() => {
                      setDockerInitResult(null);
                      void initDocker().then((res) => {
                        if ('data' in res && res.data) {
                          setDockerInitResult({ ok: res.data.ok, error: res.data.error });
                        } else {
                          const e = 'error' in res ? res.error : undefined;
                          const msg = e && 'message' in e ? e.message : e ? JSON.stringify(e) : 'Request failed';
                          setDockerInitResult({ ok: false, error: msg });
                        }
                      });
                    }}
                    size="sm"
                    variant="outline"
                  >
                    {dockerInitializing ? <Loader2 className="animate-spin" /> : null}
                    {dockerInitializing ? t('web.tools.dockerInitializing') : t('web.tools.dockerInitBtn')}
                  </Button>
                  {dockerInitResult && (
                    <span
                      className={`text-xs ${dockerInitResult.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}`}
                    >
                      {dockerInitResult.ok ? t('web.tools.dockerInitSuccess') : (dockerInitResult.error ?? 'Failed')}
                    </span>
                  )}
                </div>
              </div>
            )}

            {saveError && <p className="text-destructive text-xs">{saveError}</p>}
            <div className="flex gap-2">
              <Button
                className="flex-1"
                disabled={saving}
                onClick={() => void handleSave()}
                size="sm"
              >
                {saving ? <Loader2 className="animate-spin" /> : <Check />}
                {saving ? t('web.common.saving') : t('web.common.save')}
              </Button>
              <Button
                onClick={() => {
                  resetFromConfig('codeExec');
                  setOpenTool(null);
                  setSaveError(undefined);
                }}
                size="sm"
                variant="ghost"
              >
                {t('web.model.cancel')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Email dialog */}
      <Dialog
        onOpenChange={(o) => {
          if (!o) {
            resetFromConfig('email');
            setOpenTool(null);
            setSaveError(undefined);
          }
        }}
        open={openTool === 'email'}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Mail className="size-4" /> {t('web.tools.email')}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label>{t('web.tools.emailBackend')}</Label>
              <div className="flex gap-2">
                {(['auto', 'smtp', 'resend'] as const).map((b) => (
                  <button
                    className={`rounded-md border px-3 py-1.5 text-sm ${emailBackend === b ? 'border-ring bg-primary-subtle text-primary' : ''}`}
                    key={b}
                    onClick={() => setEmailBackend(b)}
                    type="button"
                  >
                    {b === 'auto' ? t('web.tools.searchProviderAuto') : b === 'smtp' ? 'SMTP' : 'Resend'}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email-from">{t('web.tools.emailFromLabel')}</Label>
              <Input
                id="email-from"
                onChange={(e) => setEmailFrom(e.target.value)}
                placeholder="sender@example.com"
                type="email"
                value={emailFrom}
              />
            </div>
            {(emailBackend === 'resend' || emailBackend === 'auto') && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="resend-api-key">{t('web.tools.resendApiKey')}</Label>
                <Input
                  id="resend-api-key"
                  onChange={(e) => setResendApiKey(e.target.value)}
                  placeholder="re_… or ${env:RESEND_API_KEY}"
                  value={resendApiKey}
                />
              </div>
            )}
            <label className="flex cursor-pointer items-center gap-2">
              <input
                checked={smtpEnabled}
                className="size-4"
                onChange={(e) => setSmtpEnabled(e.target.checked)}
                type="checkbox"
              />
              <span className="text-sm">{t('web.tools.configureSMTP')}</span>
            </label>
            {smtpEnabled && (
              <div className="flex flex-col gap-3 rounded-md border p-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="smtp-host">{t('web.tools.smtpHost')}</Label>
                    <Input
                      id="smtp-host"
                      onChange={(e) => setSmtpHost(e.target.value)}
                      placeholder="smtp.example.com"
                      value={smtpHost}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="smtp-port">{t('web.tools.smtpPort')}</Label>
                    <Input
                      id="smtp-port"
                      onChange={(e) => setSmtpPort(e.target.value)}
                      placeholder="465 or 587"
                      type="number"
                      value={smtpPort}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="smtp-user">{t('web.tools.smtpUser')}</Label>
                    <Input
                      id="smtp-user"
                      onChange={(e) => setSmtpUser(e.target.value)}
                      placeholder="user@example.com"
                      value={smtpUser}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="smtp-pass">{t('web.tools.smtpPass')}</Label>
                    <Input
                      id="smtp-pass"
                      onChange={(e) => setSmtpPass(e.target.value)}
                      placeholder="password or ${env:SMTP_PASS}"
                      type="text"
                      value={smtpPass}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="smtp-client">{t('web.tools.smtpClientName')}</Label>
                    <Input
                      id="smtp-client"
                      onChange={(e) => setSmtpClientName(e.target.value)}
                      placeholder="monad"
                      value={smtpClientName}
                    />
                  </div>
                </div>
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    checked={smtpSecure}
                    className="size-4"
                    id="smtp-secure"
                    onChange={(e) => setSmtpSecure(e.target.checked)}
                    type="checkbox"
                  />
                  <span className="text-sm">{t('web.tools.smtpSecure')}</span>
                </label>
              </div>
            )}
            {saveError && <p className="text-destructive text-xs">{saveError}</p>}
            <div className="flex gap-2">
              <Button
                className="flex-1"
                disabled={saving}
                onClick={() => void handleSave()}
                size="sm"
              >
                {saving ? <Loader2 className="animate-spin" /> : <Check />}
                {saving ? t('web.common.saving') : t('web.common.save')}
              </Button>
              <Button
                onClick={() => {
                  resetFromConfig('email');
                  setOpenTool(null);
                  setSaveError(undefined);
                }}
                size="sm"
                variant="ghost"
              >
                {t('web.model.cancel')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <BrowserPresetDialog
        onClose={() => setOpenTool(null)}
        open={openTool === 'browser'}
      />
      <ComputerPresetDialog
        onClose={() => setOpenTool(null)}
        open={openTool === 'computer'}
      />
      <ObscuraDialog
        onClose={() => setOpenTool(null)}
        open={openTool === 'obscura'}
      />
    </>
  );
}

function BrowserPresetCard({ onConfigure }: { onConfigure: () => void }) {
  const t = useT();
  const { config, save } = useBrowserPresetSettings();

  const summary = config?.enabled
    ? (config.engine ?? t('web.tools.browserEngineDefault'))
    : t('web.tools.browserDisabled');

  return (
    <ToolCard
      description={t('web.tools.browserPresetDesc')}
      enabled={config?.enabled ?? false}
      icon={MonitorPlay}
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
            <MonitorPlay className="size-4" /> {t('web.tools.browserPreset')}
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
              {saving ? <Loader2 className="animate-spin" /> : <Check />}
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
    <ToolCard
      description={t('web.tools.computerPresetDesc')}
      enabled={config?.enabled ?? false}
      icon={Monitor}
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
            <Monitor className="size-4" /> {t('web.tools.computerPreset')}
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
              {saving ? <Loader2 className="animate-spin" /> : <Check />}
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
    <ToolCard
      description={t('web.tools.obscuraDesc')}
      icon={Globe}
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
            <Globe className="size-4" /> {t('web.obscura.title')}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <p className="text-muted-foreground text-xs">{t('web.tools.obscuraDesc')}</p>

          {busy ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              {status?.enabled ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('web.obscura.connecting')}
                </>
              ) : (
                <>
                  <Download className="size-4 animate-pulse" />
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
                  <CheckCircle2 className="size-3" />
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
                {busy ? <Loader2 className="animate-spin" /> : null}
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
                {busy ? <Download className="animate-pulse" /> : <Download />}
                {status?.installed ? t('web.obscura.enable') : t('web.obscura.downloadEnable')}
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ToolCard({
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
  icon: React.ComponentType<{ className?: string }>;
  name: string;
  onConfigure?: () => void;
  onToggle?: (v: boolean) => void;
  optional?: boolean;
  summary: string;
}) {
  return (
    <Card
      className={`flex flex-col gap-3 p-4 transition-colors${onConfigure ? 'cursor-pointer hover:bg-muted/20' : ''}`}
      onClick={onConfigure}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="rounded-md bg-muted/50 p-1.5">
            <Icon className="size-4 text-foreground/70" />
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
        {onConfigure && <Settings2 className="size-3.5 shrink-0 text-muted-foreground/40" />}
      </div>
    </Card>
  );
}
