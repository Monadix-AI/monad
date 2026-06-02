'use client';

import type { SetToolBackendsRequest, SmtpSettings } from '@monad/protocol';

import { Button, Card, Input, Label, ScrollArea, Switch } from '@monad/ui';
import {
  Brain,
  CalendarClock,
  Check,
  Code2,
  Cpu,
  FileSearch,
  FolderOpen,
  Globe,
  Loader2,
  Mail,
  Network,
  RefreshCw,
  Settings2,
  SquareCheckBig,
  Terminal
} from 'lucide-react';
import { useEffect, useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useToolBackendsSettings } from '@/hooks/use-tool-backends-settings';
import { StudioPanel, StudioPanelHeader } from './studio/StudioPanel';

export function ToolBackendsSettings(_props: { onClose: () => void }) {
  const { config, loading, save, refetch } = useToolBackendsSettings();
  const t = useT();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();

  const [wsProvider, setWsProvider] = useState<'auto' | 'native' | 'brave' | 'ddgs'>('auto');
  const [braveApiKey, setBraveApiKey] = useState('');

  const [codeExecBackend, setCodeExecBackend] = useState<'local' | 'docker'>('local');
  const [availableCodeExecBackends, setAvailableCodeExecBackends] = useState<string[]>(['local']);

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

  const [openTool, setOpenTool] = useState<'webSearch' | 'codeExec' | 'email' | null>(null);

  useEffect(() => {
    if (!config) return;
    setWsProvider(config.webSearch.provider);
    setBraveApiKey(config.webSearch.braveApiKey ?? '');
    setCodeExecBackend((config.codeExec.backend as 'local' | 'docker') ?? 'local');
    setAvailableCodeExecBackends(config.codeExec.availableBackends);
    setEmailBackend(config.email.backend);
    setEmailFrom(config.email.from ?? '');
    setResendApiKey(config.email.resendApiKey ?? '');
    const hasEmailConfig = !!(config.email.from || config.email.smtp || config.email.resendApiKey);
    setEmailEnabled(hasEmailConfig);
    if (config.email.smtp) {
      setSmtpEnabled(true);
      setSmtpHost(config.email.smtp.host);
      setSmtpPort(config.email.smtp.port?.toString() ?? '');
      setSmtpUser(config.email.smtp.user ?? '');
      setSmtpPass(config.email.smtp.pass ?? '');
      setSmtpSecure(config.email.smtp.secure ?? false);
      setSmtpClientName(config.email.smtp.clientName ?? '');
    } else {
      setSmtpEnabled(false);
    }
  }, [config]);

  const resetFromConfig = (tool: 'webSearch' | 'codeExec' | 'email') => {
    if (!config) return;
    if (tool === 'webSearch') {
      setWsProvider(config.webSearch.provider);
      setBraveApiKey(config.webSearch.braveApiKey ?? '');
    } else if (tool === 'codeExec') {
      setCodeExecBackend((config.codeExec.backend as 'local' | 'docker') ?? 'local');
    } else {
      setEmailBackend(config.email.backend);
      setEmailFrom(config.email.from ?? '');
      setResendApiKey(config.email.resendApiKey ?? '');
      if (config.email.smtp) {
        setSmtpEnabled(true);
        setSmtpHost(config.email.smtp.host);
        setSmtpPort(config.email.smtp.port?.toString() ?? '');
        setSmtpUser(config.email.smtp.user ?? '');
        setSmtpPass(config.email.smtp.pass ?? '');
        setSmtpSecure(config.email.smtp.secure ?? false);
        setSmtpClientName(config.email.smtp.clientName ?? '');
      } else {
        setSmtpEnabled(false);
      }
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError(undefined);
    try {
      const smtp: SmtpSettings | null =
        emailEnabled && smtpEnabled && smtpHost
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
        email: emailEnabled
          ? { backend: emailBackend, from: emailFrom || undefined, resendApiKey: resendApiKey || undefined, smtp }
          : { backend: 'auto', from: undefined, resendApiKey: undefined, smtp: null },
        codeExec: { backend: codeExecBackend }
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

  const codeExecLabel = codeExecBackend === 'docker' ? t('web.tools.dockerBackend') : t('web.tools.localBackend');

  const emailSummary = !emailEnabled
    ? t('web.tools.emailDisabled')
    : emailFrom
      ? emailFrom
      : emailBackend === 'smtp'
        ? 'SMTP'
        : emailBackend === 'resend'
          ? 'Resend'
          : 'Auto';

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
            <RefreshCw className={loading ? 'animate-spin' : ''} />
          </Button>
        }
        subtitle={t('web.tools.subtitle')}
        title={t('web.tools.title')}
      />

      {loading ? (
        <div className="flex items-center gap-2 p-5 text-muted-foreground text-sm">
          <Loader2 className="size-4 animate-spin" />
          {t('web.common.loading')}
        </div>
      ) : (
        <ScrollArea className="flex-1">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-3 p-5">
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
                if (!v) void handleSave();
              }}
              optional
              summary={emailSummary}
            />
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
        </ScrollArea>
      )}

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
          if (!o) {
            resetFromConfig('codeExec');
            setOpenTool(null);
            setSaveError(undefined);
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
              <div className="flex gap-2">
                {(['local', 'docker'] as const).map((b) => {
                  const available = availableCodeExecBackends.includes(b);
                  return (
                    <button
                      className={`rounded-md border px-3 py-1.5 text-sm transition-opacity ${codeExecBackend === b ? 'border-ring bg-primary-subtle text-primary' : ''} ${!available ? 'cursor-not-allowed opacity-40' : ''}`}
                      disabled={!available}
                      key={b}
                      onClick={() => available && setCodeExecBackend(b)}
                      title={!available ? t('web.tools.dockerInstallHint') : undefined}
                      type="button"
                    >
                      {b === 'local' ? t('web.tools.localBackend') : t('web.tools.dockerBackend')}
                    </button>
                  );
                })}
              </div>
              <p className="text-muted-foreground text-xs">
                {codeExecBackend === 'docker' ? t('web.tools.dockerDesc') : t('web.tools.localDesc')}
                {!availableCodeExecBackends.includes('docker') && (
                  <span className="ml-1 text-warning">
                    {t('web.tools.dockerNotRunning', { cmd: 'podman machine start' })}
                  </span>
                )}
              </p>
            </div>
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
                    {b === 'auto' ? 'Auto' : b === 'smtp' ? 'SMTP' : 'Resend'}
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
    </StudioPanel>
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
