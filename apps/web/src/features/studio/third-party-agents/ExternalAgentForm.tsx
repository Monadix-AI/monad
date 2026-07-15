import type {
  ExternalAgentAdapterSettings,
  ExternalAgentLaunchMode,
  ExternalAgentPresetView,
  ExternalAgentProjectTemplate,
  ExternalAgentProvider,
  ExternalAgentSetting,
  ExternalAgentView
} from '@monad/protocol';
import type { Dispatch, SetStateAction } from 'react';

import { Cancel01Icon, LoaderPinwheelIcon, PlusSignIcon, SaveIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch } from '@monad/ui';
import { useState } from 'react';

import { useT } from '#/components/I18nProvider';
import {
  canDisableAutopilot,
  externalAgentLaunchModeOptions,
  externalAgentSettingDescription,
  externalAgentSettings,
  normalizeExternalAgentLaunchMode
} from './external-agent-settings-model';
import {
  argsToStr,
  envToStr,
  externalAgentReasoningEffortsForModel,
  modelOptionsToStr,
  newProjectTemplateEditorRow,
  nextTemplateId,
  normalizeProjectTemplates,
  type ProjectTemplateEditorRow,
  strToArgs,
  strToEnv,
  strToModelOptions
} from './external-agent-settings-utils';

const SELECT_EMPTY_VALUE = '__monad_empty__';

export function AgentForm({
  agent,
  title,
  submitLabel,
  mode,
  preset,
  onSubmit,
  onCancel
}: {
  agent?: ExternalAgentView;
  title?: string;
  submitLabel: string;
  mode: 'create' | 'settings';
  preset?: ExternalAgentPresetView;
  onSubmit: (a: ExternalAgentView) => Promise<void>;
  onCancel?: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(agent?.name ?? '');
  const [provider, setProvider] = useState<ExternalAgentProvider>(agent?.provider ?? 'codex');
  const [command, setCommand] = useState(agent?.command ?? '');
  const [args, setArgs] = useState(argsToStr(agent?.args));
  const [modelOptions, setModelOptions] = useState(modelOptionsToStr(agent?.modelOptions));
  const [env, setEnv] = useState(envToStr(agent?.env));
  const [projectTemplates, setProjectTemplates] = useState<ProjectTemplateEditorRow[]>(
    (agent?.projectTemplates ?? []).map((template, index) =>
      newProjectTemplateEditorRow(template, `${template.id}:${index}`)
    )
  );
  const canProxyApprovals = agent ? canDisableAutopilot(agent, preset) : false;
  const initialLaunchModeOptions = agent ? externalAgentLaunchModeOptions(agent, preset) : ['app-server' as const];
  const [defaultLaunchMode, setDefaultLaunchMode] = useState<ExternalAgentLaunchMode>(
    normalizeExternalAgentLaunchMode(agent?.defaultLaunchMode ?? 'app-server', initialLaunchModeOptions)
  );
  const [appServerTransport, setAppServerTransport] = useState(agent?.appServerTransport ?? '');
  const [adapterSettingsValues, setAdapterSettingsValues] = useState<ExternalAgentAdapterSettings>(
    agent?.adapterSettings ?? {}
  );
  const [allowAutopilot, setAllowAutopilot] = useState(
    mode === 'settings' && !canProxyApprovals ? true : (agent?.allowAutopilot ?? true)
  );
  const [busy, setBusy] = useState(false);
  const launchModeOptions = agent
    ? externalAgentLaunchModeOptions({ ...agent, defaultLaunchMode }, preset)
    : [defaultLaunchMode];
  const showIdentityFields = mode === 'create';
  const showAdvanced = mode === 'settings';
  const canToggleAutopilot = mode === 'create' || canProxyApprovals;
  const effectiveAllowAutopilot = mode === 'settings' && !canProxyApprovals ? true : allowAutopilot;
  const adapterSettings = agent ? externalAgentSettings({ ...agent, defaultLaunchMode }, preset) : [];

  const submit = async () => {
    if (!name.trim() || !command.trim()) return;
    setBusy(true);
    try {
      const envRec = strToEnv(env);
      await onSubmit({
        name: name.trim(),
        provider,
        productIcon: agent?.productIcon,
        command: command.trim(),
        args: strToArgs(args),
        modelOptions: showIdentityFields ? strToModelOptions(modelOptions) : agent?.modelOptions,
        reasoningEfforts: agent?.reasoningEfforts,
        reasoningEffortsByModel: agent?.reasoningEffortsByModel,
        env: Object.keys(envRec).length ? envRec : undefined,
        projectTemplates: normalizeProjectTemplates(projectTemplates),
        enabled: agent?.enabled ?? true,
        defaultLaunchMode,
        appServerTransport: appServerTransport
          ? (appServerTransport as ExternalAgentView['appServerTransport'])
          : undefined,
        allowAutopilot: effectiveAllowAutopilot,
        approvalOwnership: 'provider-owned',
        capabilities: agent?.capabilities,
        adapterSettings: Object.keys(adapterSettingsValues).length ? adapterSettingsValues : undefined
      });
    } finally {
      setBusy(false);
    }
  };

  const wrapper = title
    ? 'flex flex-col gap-3 rounded-md border border-primary/30 bg-primary/5 p-3'
    : 'flex flex-col gap-3';

  return (
    <div className={wrapper}>
      {title ? (
        <div className="flex items-center justify-between">
          <span className="font-medium text-sm">{title}</span>
          {onCancel ? (
            <Button
              className="size-6"
              onClick={onCancel}
              size="icon"
              variant="ghost"
            >
              <HugeiconsIcon icon={Cancel01Icon} />
            </Button>
          ) : null}
        </div>
      ) : null}

      {showIdentityFields ? (
        <>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">{t('web.acp.name')}</Label>
            <Input
              onChange={(e) => setName(e.target.value)}
              placeholder={t('web.externalAgent.namePlaceholder')}
              value={name}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">{t('web.externalAgent.provider')}</Label>
            <Select
              onValueChange={(value) => setProvider(value as ExternalAgentProvider)}
              value={provider}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="codex">Codex</SelectItem>
                <SelectItem value="claude-code">Claude Code</SelectItem>
                <SelectItem value="gemini">Gemini</SelectItem>
                <SelectItem value="qwen">Qwen Code</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">{t('web.acp.command')}</Label>
            <Input
              onChange={(e) => setCommand(e.target.value)}
              placeholder={t('web.externalAgent.commandPlaceholder')}
              value={command}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">{t('web.externalAgent.modelOptions')}</Label>
            <textarea
              className="min-h-16 rounded-md border bg-transparent px-2 py-1 font-mono text-xs"
              onChange={(e) => setModelOptions(e.target.value)}
              placeholder={t('web.externalAgent.modelOptionsPlaceholder')}
              value={modelOptions}
            />
          </div>
        </>
      ) : null}
      {mode === 'settings' ? (
        <AdapterSettingsFields
          adapterSettings={adapterSettingsValues}
          appServerTransport={appServerTransport}
          canToggleAutopilot={canToggleAutopilot}
          command={command}
          defaultLaunchMode={defaultLaunchMode}
          effectiveAllowAutopilot={effectiveAllowAutopilot}
          setAdapterSettings={setAdapterSettingsValues}
          setAllowAutopilot={setAllowAutopilot}
          setAppServerTransport={setAppServerTransport}
          setCommand={setCommand}
          setDefaultLaunchMode={setDefaultLaunchMode}
          settings={adapterSettings}
        />
      ) : (
        <div className="flex flex-col gap-1">
          <Label className="text-xs">{t('web.externalAgent.launchMode')}</Label>
          <Select
            onValueChange={(value) => setDefaultLaunchMode(value as ExternalAgentLaunchMode)}
            value={defaultLaunchMode}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {launchModeOptions.map((launchMode) => (
                <SelectItem
                  key={launchMode}
                  value={launchMode}
                >
                  {launchMode}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <ProjectTemplatesEditor
        modelOptions={strToModelOptions(modelOptions)}
        onChange={setProjectTemplates}
        reasoningEfforts={agent?.reasoningEfforts}
        reasoningEffortsByModel={agent?.reasoningEffortsByModel}
        templates={projectTemplates}
      />
      {mode === 'create' ? (
        <div className="flex flex-col gap-1">
          <Label className="text-xs">{t('web.externalAgent.autopilot')}</Label>
          <div className="flex items-center gap-2">
            <Switch
              aria-label={t('web.externalAgent.autopilot')}
              checked={effectiveAllowAutopilot}
              disabled={!canToggleAutopilot}
              onCheckedChange={() => setAllowAutopilot((v) => !v)}
            />
            <span className="text-sm">
              {effectiveAllowAutopilot ? t('web.acp.osSandboxOn') : t('web.acp.osSandboxOff')}
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground">{t('web.externalAgent.autopilotHint')}</p>
        </div>
      ) : null}
      {showAdvanced ? (
        <details className="group rounded-md border bg-muted/20">
          <summary className="flex list-none items-center justify-between px-3 py-2 font-medium text-xs">
            {t('web.externalAgent.advanced')}
          </summary>
          <div className="flex flex-col gap-3 border-t p-3">
            <ArgsEnvFields
              args={args}
              env={env}
              setArgs={setArgs}
              setEnv={setEnv}
            />
          </div>
        </details>
      ) : (
        <ArgsEnvFields
          args={args}
          env={env}
          setArgs={setArgs}
          setEnv={setEnv}
        />
      )}

      <Button
        className="self-start"
        disabled={busy || !name.trim() || !command.trim()}
        onClick={submit}
        size="sm"
      >
        {busy ? (
          <HugeiconsIcon
            className="animate-spin"
            icon={LoaderPinwheelIcon}
          />
        ) : title ? (
          <HugeiconsIcon icon={PlusSignIcon} />
        ) : (
          <HugeiconsIcon icon={SaveIcon} />
        )}{' '}
        {submitLabel}
      </Button>
    </div>
  );
}

function AdapterSettingsFields({
  settings,
  defaultLaunchMode,
  appServerTransport,
  adapterSettings,
  command,
  effectiveAllowAutopilot,
  canToggleAutopilot,
  setDefaultLaunchMode,
  setAppServerTransport,
  setAdapterSettings,
  setAllowAutopilot,
  setCommand
}: {
  settings: ExternalAgentSetting[];
  defaultLaunchMode: ExternalAgentLaunchMode;
  appServerTransport: string;
  adapterSettings: ExternalAgentAdapterSettings;
  command: string;
  effectiveAllowAutopilot: boolean;
  canToggleAutopilot: boolean;
  setDefaultLaunchMode: (value: ExternalAgentLaunchMode) => void;
  setAppServerTransport: (value: string) => void;
  setAdapterSettings: Dispatch<SetStateAction<ExternalAgentAdapterSettings>>;
  setAllowAutopilot: Dispatch<SetStateAction<boolean>>;
  setCommand: (value: string) => void;
}) {
  const t = useT();

  const visibleSettings = settings.filter(
    (setting) => setting.key !== 'appServerTransport' || defaultLaunchMode === 'app-server'
  );
  const stringValue = (key: string): string => {
    if (key === 'defaultLaunchMode') return defaultLaunchMode;
    if (key === 'appServerTransport') return appServerTransport;
    if (key === 'command') return command;
    const value = adapterSettings[key];
    if (typeof value === 'string') return value;
    return '';
  };
  const setStringValue = (key: string, value: string) => {
    if (key === 'defaultLaunchMode') setDefaultLaunchMode(value as ExternalAgentLaunchMode);
    if (key === 'appServerTransport') setAppServerTransport(value);
    if (key === 'command') setCommand(value);
    if (key !== 'defaultLaunchMode' && key !== 'appServerTransport' && key !== 'command') {
      setAdapterSettings((current) => {
        const next = { ...current };
        if (value) next[key] = value;
        else delete next[key];
        return next;
      });
    }
  };

  return (
    <>
      {visibleSettings.map((setting) => {
        if (setting.kind === 'switch') {
          const checked =
            setting.key === 'allowAutopilot' ? effectiveAllowAutopilot : adapterSettings[setting.key] === true;
          const description = externalAgentSettingDescription(setting, { canToggleAutopilot });
          return (
            <div
              className="flex flex-col gap-1"
              key={setting.key}
            >
              <Label className="text-xs">{setting.label}</Label>
              <div className="flex items-center gap-2">
                <Switch
                  aria-label={setting.label}
                  checked={checked}
                  disabled={setting.key === 'allowAutopilot' && !canToggleAutopilot}
                  onCheckedChange={() => {
                    if (setting.key === 'allowAutopilot') {
                      setAllowAutopilot((v) => !v);
                      return;
                    }
                    setAdapterSettings((current) => ({ ...current, [setting.key]: !checked }));
                  }}
                />
                <span className="text-sm">{checked ? t('web.acp.osSandboxOn') : t('web.acp.osSandboxOff')}</span>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {description === 'approvalProxyUnavailable'
                  ? t('web.externalAgent.approvalProxyUnavailable')
                  : (description ?? t('web.externalAgent.autopilotHint'))}
              </p>
            </div>
          );
        }

        if (setting.kind === 'select') {
          return (
            <div
              className="flex flex-col gap-1"
              key={setting.key}
            >
              <Label className="text-xs">{setting.label}</Label>
              <Select
                onValueChange={(value) => setStringValue(setting.key, value === SELECT_EMPTY_VALUE ? '' : value)}
                value={stringValue(setting.key) || SELECT_EMPTY_VALUE}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {setting.placeholder ? (
                    <SelectItem value={SELECT_EMPTY_VALUE}>{setting.placeholder}</SelectItem>
                  ) : null}
                  {setting.options.map((option) => (
                    <SelectItem
                      key={option.value}
                      value={option.value}
                    >
                      {option.label ?? option.value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {setting.description ? <p className="text-[11px] text-muted-foreground">{setting.description}</p> : null}
            </div>
          );
        }

        return (
          <div
            className="flex flex-col gap-1"
            key={setting.key}
          >
            <Label className="text-xs">{setting.label}</Label>
            {setting.multiline ? (
              <textarea
                className="min-h-16 rounded-md border bg-transparent px-2 py-1 font-mono text-xs"
                onChange={(e) => setStringValue(setting.key, e.target.value)}
                placeholder={setting.placeholder}
                value={stringValue(setting.key)}
              />
            ) : (
              <Input
                onChange={(e) => setStringValue(setting.key, e.target.value)}
                placeholder={setting.placeholder}
                value={stringValue(setting.key)}
              />
            )}
            {setting.description ? <p className="text-[11px] text-muted-foreground">{setting.description}</p> : null}
          </div>
        );
      })}
    </>
  );
}

function ArgsEnvFields({
  args,
  env,
  setArgs,
  setEnv
}: {
  args: string;
  env: string;
  setArgs: (value: string) => void;
  setEnv: (value: string) => void;
}) {
  const t = useT();

  return (
    <>
      <div className="flex flex-col gap-1">
        <Label className="text-xs">{t('web.acp.args')}</Label>
        <Input
          onChange={(e) => setArgs(e.target.value)}
          placeholder={t('web.externalAgent.argsPlaceholder')}
          value={args}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label className="text-xs">{t('web.acp.env')}</Label>
        <textarea
          className="min-h-16 rounded-md border bg-transparent px-2 py-1 font-mono text-xs"
          onChange={(e) => setEnv(e.target.value)}
          placeholder={t('web.acp.envPlaceholder')}
          value={env}
        />
      </div>
    </>
  );
}

function ProjectTemplatesEditor({
  templates,
  modelOptions,
  reasoningEfforts,
  reasoningEffortsByModel,
  onChange
}: {
  templates: ProjectTemplateEditorRow[];
  modelOptions: string[];
  reasoningEfforts?: string[];
  reasoningEffortsByModel?: Record<string, string[]>;
  onChange: (templates: ProjectTemplateEditorRow[]) => void;
}) {
  const t = useT();
  const updateTemplate = (index: number, patch: Partial<ExternalAgentProjectTemplate>) => {
    onChange(templates.map((template, i) => (i === index ? { ...template, ...patch } : template)));
  };
  const addTemplate = () => {
    const id = nextTemplateId(templates);
    onChange([...templates, newProjectTemplateEditorRow({ id, displayName: `Template ${templates.length + 1}` })]);
  };
  const removeTemplate = (index: number) => {
    onChange(templates.filter((_, i) => i !== index));
  };
  const effortsForModel = (modelId: string | undefined) => {
    return externalAgentReasoningEffortsForModel(reasoningEfforts, reasoningEffortsByModel, modelId);
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <Label className="text-xs">{t('web.externalAgent.projectTemplates')}</Label>
          <p className="mt-1 text-[11px] text-muted-foreground">{t('web.externalAgent.projectTemplatesHint')}</p>
        </div>
        <Button
          onClick={addTemplate}
          size="sm"
          type="button"
          variant="outline"
        >
          <HugeiconsIcon icon={PlusSignIcon} />
          {t('web.externalAgent.addProjectTemplate')}
        </Button>
      </div>
      {templates.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-2 text-muted-foreground text-xs">
          {t('web.externalAgent.noProjectTemplates')}
        </p>
      ) : null}
      {templates.map((template, index) => {
        const availableEfforts = effortsForModel(template.modelId);
        return (
          <div
            className="grid gap-2 rounded-md border bg-card p-3"
            key={template.rowKey}
          >
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <Label className="text-xs">{t('web.externalAgent.projectTemplateId')}</Label>
                <Input
                  onChange={(e) => updateTemplate(index, { id: e.target.value })}
                  placeholder="reviewer"
                  value={template.id}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label className="text-xs">{t('web.externalAgent.projectTemplateDisplayName')}</Label>
                <Input
                  onChange={(e) => updateTemplate(index, { displayName: e.target.value })}
                  placeholder="Reviewer"
                  value={template.displayName}
                />
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="flex flex-col gap-1">
                <Label className="text-xs">{t('web.workplace.model')}</Label>
                {modelOptions.length > 0 ? (
                  <Select
                    onValueChange={(value) => {
                      const modelId = value === SELECT_EMPTY_VALUE ? undefined : value;
                      const nextEfforts = effortsForModel(modelId);
                      updateTemplate(index, {
                        modelId,
                        reasoningEffort: nextEfforts.includes(template.reasoningEffort ?? '')
                          ? template.reasoningEffort
                          : undefined
                      });
                    }}
                    value={template.modelId ?? SELECT_EMPTY_VALUE}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={SELECT_EMPTY_VALUE}>{t('web.workplace.defaultModel')}</SelectItem>
                      {modelOptions.map((model) => (
                        <SelectItem
                          key={model}
                          value={model}
                        >
                          {model}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    onChange={(e) => updateTemplate(index, { modelId: e.target.value || undefined })}
                    placeholder="gpt-5.5"
                    value={template.modelId ?? ''}
                  />
                )}
              </div>
              {availableEfforts.length > 0 ? (
                <div className="flex flex-col gap-1">
                  <Label className="text-xs">{t('web.workplace.reasoningEffort')}</Label>
                  <Select
                    onValueChange={(value) =>
                      updateTemplate(index, {
                        reasoningEffort: value === SELECT_EMPTY_VALUE ? undefined : value
                      })
                    }
                    value={template.reasoningEffort ?? SELECT_EMPTY_VALUE}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={SELECT_EMPTY_VALUE}>{t('web.workplace.reasoningEffort')}</SelectItem>
                      {availableEfforts.map((effort) => (
                        <SelectItem
                          key={effort}
                          value={effort}
                        >
                          {effort}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
              <div className="flex flex-col gap-1">
                <Label className="text-xs">{t('web.workplace.enableFastMode')}</Label>
                <Select
                  onValueChange={(value) =>
                    updateTemplate(index, {
                      speed: (value === SELECT_EMPTY_VALUE ? undefined : value) as ExternalAgentProjectTemplate['speed']
                    })
                  }
                  value={template.speed ?? SELECT_EMPTY_VALUE}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={SELECT_EMPTY_VALUE}>
                      {t('web.externalAgent.projectTemplateStandardSpeed')}
                    </SelectItem>
                    <SelectItem value="fast">{t('web.externalAgent.projectTemplateFastSpeed')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs">{t('web.externalAgent.projectTemplatePrompt')}</Label>
              <textarea
                className="min-h-16 rounded-md border bg-transparent px-2 py-1 text-xs"
                onChange={(e) => updateTemplate(index, { customPrompt: e.target.value || undefined })}
                placeholder={t('web.externalAgent.projectTemplatePromptPlaceholder')}
                value={template.customPrompt ?? ''}
              />
            </div>
            <Button
              className="w-fit"
              onClick={() => removeTemplate(index)}
              size="sm"
              type="button"
              variant="ghost"
            >
              <HugeiconsIcon icon={Cancel01Icon} />
              {t('web.remove')}
            </Button>
          </div>
        );
      })}
    </div>
  );
}
