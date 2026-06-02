import { useInitDockerBackendMutation } from '@monad/client-rtk';
import { Skeleton } from '@monad/ui';
import { useCallback, useEffect, useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { RefreshButton } from '#/components/RefreshButton';
import { useToolBackendsSettings } from '#/hooks/use-tool-backends-settings';
import { CapabilitySection } from './CapabilitySection';
import { ToolCard } from './ToolCard';
import { CodeExecSettingsDialog, EmailSettingsDialog, WebSearchSettingsDialog } from './ToolSettingsDialogs';
import {
  buildToolBackendsRequest,
  type CodeExecBackend,
  createCredentialEdit,
  type EmailBackend,
  markCredentialForRemoval,
  resetCredentialEdit,
  setCredentialReplacement,
  type WebSearchProvider
} from './tool-backends-request';

function ToolsSectionSkeleton() {
  return (
    <div
      aria-busy="true"
      className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-3"
    >
      {Array.from({ length: 6 }, (_, i) => `tool-card-skeleton-${i}`).map((key) => (
        <div
          className="flex min-h-28 flex-col gap-2 rounded-lg border bg-card p-4"
          key={key}
        >
          <div className="flex items-start gap-3">
            <Skeleton className="size-9 rounded-md" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-32 rounded" />
              <Skeleton className="h-3 w-full rounded" />
              <Skeleton className="h-3 w-4/5 rounded" />
            </div>
          </div>
          <Skeleton className="mt-auto h-5 w-24 rounded-full" />
        </div>
      ))}
    </div>
  );
}

// The Tools half of the Capabilities panel: native built-in tool cards. MCP-backed presets live in
// the MCP section so the two capability surfaces stay visually separate.
export function ToolsSection() {
  const { config, loading, save, refetch } = useToolBackendsSettings();
  const [initDocker, { isLoading: dockerInitializing }] = useInitDockerBackendMutation();
  const t = useT();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [dockerInitResult, setDockerInitResult] = useState<{ ok: boolean; error?: string } | null>(null);

  const [wsProvider, setWsProvider] = useState<WebSearchProvider>('auto');
  const [braveApiKey, setBraveApiKey] = useState(createCredentialEdit);

  const [codeExecBackend, setCodeExecBackend] = useState<CodeExecBackend>('follow-system');
  const [availableCodeExecBackends, setAvailableCodeExecBackends] = useState<string[]>(['follow-system']);
  const [e2bApiKey, setE2bApiKey] = useState(createCredentialEdit);
  const [dockerImage, setDockerImage] = useState('');

  const [emailEnabled, setEmailEnabled] = useState(false);
  const [emailBackend, setEmailBackend] = useState<EmailBackend>('auto');
  const [emailFrom, setEmailFrom] = useState('');
  const [resendApiKey, setResendApiKey] = useState(createCredentialEdit);
  const [smtpEnabled, setSmtpEnabled] = useState(false);
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('');
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPass, setSmtpPass] = useState(createCredentialEdit);
  const [smtpSecure, setSmtpSecure] = useState(false);
  const [smtpClientName, setSmtpClientName] = useState('');

  const [openTool, setOpenTool] = useState<'webSearch' | 'codeExec' | 'email' | null>(null);

  // Shared SMTP→state hydration used by both the initial load and the dialog cancel/reset path.
  // useCallback (over stable setters) keeps it out of effect-dependency churn.
  const applyEmailConfig = useCallback((cfg: NonNullable<typeof config>) => {
    setEmailBackend(cfg.email.backend);
    setEmailFrom(cfg.email.from ?? '');
    setResendApiKey((edit) => resetCredentialEdit(edit));
    if (cfg.email.smtp) {
      setSmtpEnabled(true);
      setSmtpHost(cfg.email.smtp.host);
      setSmtpPort(cfg.email.smtp.port?.toString() ?? '');
      setSmtpUser(cfg.email.smtp.user ?? '');
      setSmtpPass((edit) => resetCredentialEdit(edit));
      setSmtpSecure(cfg.email.smtp.secure ?? false);
      setSmtpClientName(cfg.email.smtp.clientName ?? '');
    } else {
      setSmtpEnabled(false);
      setSmtpPass((edit) => resetCredentialEdit(edit));
    }
  }, []);

  useEffect(() => {
    if (!config) return;
    setWsProvider(config.webSearch.provider);
    setBraveApiKey((edit) => resetCredentialEdit(edit));
    const b = config.codeExec.backend;
    setCodeExecBackend((b === 'local' ? 'follow-system' : b) as CodeExecBackend);
    setAvailableCodeExecBackends(config.codeExec.availableBackends);
    setE2bApiKey((edit) => resetCredentialEdit(edit));
    setDockerImage(config.codeExec.dockerImage ?? '');
    const hasEmailConfig = !!(config.email.from || config.email.smtp || config.email.resendApiKey.configured);
    setEmailEnabled(hasEmailConfig);
    applyEmailConfig(config);
  }, [config, applyEmailConfig]);

  const resetFromConfig = (tool: 'webSearch' | 'codeExec' | 'email') => {
    if (!config) return;
    if (tool === 'webSearch') {
      setWsProvider(config.webSearch.provider);
      setBraveApiKey((edit) => resetCredentialEdit(edit));
    } else if (tool === 'codeExec') {
      const b = config.codeExec.backend;
      setCodeExecBackend((b === 'local' ? 'follow-system' : b) as CodeExecBackend);
      setE2bApiKey((edit) => resetCredentialEdit(edit));
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
      const req = buildToolBackendsRequest({
        webSearchProvider: wsProvider,
        braveApiKey,
        codeExecBackend,
        e2bApiKey,
        dockerImage,
        emailEnabled: effectiveEmailEnabled,
        emailBackend,
        emailFrom,
        resendApiKey,
        smtpEnabled,
        smtpHost,
        smtpPort,
        smtpUser,
        smtpPass,
        smtpSecure,
        smtpClientName
      });
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

  const closeTool = (tool: 'webSearch' | 'codeExec' | 'email') => {
    resetFromConfig(tool);
    setOpenTool(null);
    setSaveError(undefined);
    if (tool === 'codeExec') setDockerInitResult(null);
  };

  const handleInitDocker = () => {
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
  };

  return (
    <>
      <CapabilitySection
        actions={
          <RefreshButton
            className="size-7"
            iconOnly
            label={t('web.common.refresh')}
            loading={loading}
            onClick={refetch}
            size="icon"
            variant="ghost"
          />
        }
        subtitle={t('web.studio.capabilitiesToolsSubtitle')}
        title={t('web.studio.capabilitiesToolsSection')}
      >
        {loading ? (
          <ToolsSectionSkeleton />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-3">
            <ToolCard
              capabilityIcon="web-search"
              description={t('web.tools.webSearchDesc')}
              name={t('web.tools.searchTool')}
              onConfigure={() => setOpenTool('webSearch')}
              summary={wsProviderLabel}
            />
            <ToolCard
              capabilityIcon="code-execution"
              description={t('web.tools.codeExecDesc')}
              name={t('web.tools.codeExec')}
              onConfigure={() => setOpenTool('codeExec')}
              summary={codeExecLabel}
            />
            <ToolCard
              capabilityIcon="email-messaging"
              description={t('web.tools.emailDesc')}
              enabled={emailEnabled}
              name={t('web.tools.email')}
              onConfigure={() => setOpenTool('email')}
              onToggle={(v) => {
                setEmailEnabled(v);
                if (!v) void handleSave({ emailEnabled: false });
              }}
              optional
              summary={emailSummary}
            />
            <ToolCard
              capabilityIcon="file-system"
              description={t('web.tools.filesystemDesc')}
              name={t('web.tools.filesystem')}
              summary={t('web.tools.alwaysOn')}
            />
            <ToolCard
              capabilityIcon="shell-terminal"
              description={t('web.tools.shellDesc')}
              name={t('web.tools.shell')}
              summary={t('web.tools.alwaysOn')}
            />
            <ToolCard
              capabilityIcon="process-runtime"
              description={t('web.tools.processDesc')}
              name={t('web.tools.process')}
              summary={t('web.tools.alwaysOn')}
            />
            <ToolCard
              capabilityIcon="network-access"
              description={t('web.tools.networkDesc')}
              name={t('web.tools.network')}
              summary={t('web.tools.alwaysOn')}
            />
            <ToolCard
              capabilityIcon="web-extraction"
              description={t('web.tools.webExtractDesc')}
              name={t('web.tools.webExtract')}
              summary={t('web.tools.alwaysOn')}
            />
            <ToolCard
              capabilityIcon="task-list"
              description={t('web.tools.todoDesc')}
              name={t('web.tools.todo')}
              summary={t('web.tools.alwaysOn')}
            />
            <ToolCard
              capabilityIcon="memory"
              description={t('web.tools.memoryDesc')}
              name={t('web.tools.memory')}
              summary={t('web.tools.alwaysOn')}
            />
            <ToolCard
              capabilityIcon="schedule-automation"
              description={t('web.tools.scheduleDesc')}
              name={t('web.tools.schedule')}
              summary={t('web.tools.alwaysOn')}
            />
          </div>
        )}
      </CapabilitySection>

      <WebSearchSettingsDialog
        braveApiKey={braveApiKey.value}
        braveApiKeyConfigured={config?.webSearch.braveApiKey.configured ?? false}
        braveApiKeyRemovalPending={braveApiKey.pendingRemoval}
        onCancel={() => closeTool('webSearch')}
        onRemoveBraveApiKey={() => setBraveApiKey((edit) => markCredentialForRemoval(edit))}
        onSave={() => void handleSave()}
        open={openTool === 'webSearch'}
        saveError={saveError}
        saving={saving}
        setBraveApiKey={(value) => setBraveApiKey((edit) => setCredentialReplacement(edit, value))}
        setWsProvider={setWsProvider}
        wsProvider={wsProvider}
      />
      <CodeExecSettingsDialog
        availableCodeExecBackends={availableCodeExecBackends}
        codeExecBackend={codeExecBackend}
        dockerImage={dockerImage}
        dockerInitializing={dockerInitializing}
        dockerInitResult={dockerInitResult}
        e2bApiKey={e2bApiKey.value}
        e2bApiKeyConfigured={config?.codeExec.e2bApiKey.configured ?? false}
        e2bApiKeyRemovalPending={e2bApiKey.pendingRemoval}
        onCancel={() => closeTool('codeExec')}
        onInitDocker={handleInitDocker}
        onOpen={() => {
          refetch();
          setDockerInitResult(null);
        }}
        onRemoveE2bApiKey={() => setE2bApiKey((edit) => markCredentialForRemoval(edit))}
        onSave={() => void handleSave()}
        open={openTool === 'codeExec'}
        saveError={saveError}
        saving={saving}
        setCodeExecBackend={setCodeExecBackend}
        setDockerImage={setDockerImage}
        setE2bApiKey={(value) => setE2bApiKey((edit) => setCredentialReplacement(edit, value))}
      />
      <EmailSettingsDialog
        emailBackend={emailBackend}
        emailFrom={emailFrom}
        onCancel={() => closeTool('email')}
        onRemoveResendApiKey={() => setResendApiKey((edit) => markCredentialForRemoval(edit))}
        onRemoveSmtpPass={() => setSmtpPass((edit) => markCredentialForRemoval(edit))}
        onSave={() => void handleSave()}
        open={openTool === 'email'}
        resendApiKey={resendApiKey.value}
        resendApiKeyConfigured={config?.email.resendApiKey.configured ?? false}
        resendApiKeyRemovalPending={resendApiKey.pendingRemoval}
        saveError={saveError}
        saving={saving}
        setEmailBackend={setEmailBackend}
        setEmailFrom={setEmailFrom}
        setResendApiKey={(value) => setResendApiKey((edit) => setCredentialReplacement(edit, value))}
        setSmtpClientName={setSmtpClientName}
        setSmtpEnabled={setSmtpEnabled}
        setSmtpHost={setSmtpHost}
        setSmtpPass={(value) => setSmtpPass((edit) => setCredentialReplacement(edit, value))}
        setSmtpPort={setSmtpPort}
        setSmtpSecure={setSmtpSecure}
        setSmtpUser={setSmtpUser}
        smtpClientName={smtpClientName}
        smtpEnabled={smtpEnabled}
        smtpHost={smtpHost}
        smtpPass={smtpPass.value}
        smtpPassConfigured={config?.email.smtp?.pass.configured ?? false}
        smtpPassRemovalPending={smtpPass.pendingRemoval}
        smtpPort={smtpPort}
        smtpSecure={smtpSecure}
        smtpUser={smtpUser}
      />
    </>
  );
}
