import type {
  NativeCliAgentAdapterSettings,
  NativeCliAgentPresetView,
  NativeCliAgentSetting,
  NativeCliAgentView,
  NativeCliLaunchMode,
  NativeCliProjectTemplate,
  NativeCliProvider
} from '@monad/protocol';
import type { Dispatch, SetStateAction } from 'react';

import { Cancel01Icon, LoaderPinwheelIcon, PlusSignIcon, SaveIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch } from '@monad/ui';
import { useState } from 'react';

import { useT } from '@/components/I18nProvider';
import {
  canDisableAutopilot,
  nativeCliAgentSettings,
  nativeCliLaunchModeOptions,
  nativeCliSettingDescription
} from './native-cli-agent-settings-model';
import {
  argsToStr,
  envToStr,
  modelOptionsToStr,
  newProjectTemplateEditorRow,
  nextTemplateId,
  normalizeProjectTemplates,
  type ProjectTemplateEditorRow,
  strToArgs,
  strToEnv,
  strToModelOptions
} from './native-cli-agent-settings-utils';

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
  agent?: NativeCliAgentView;
  title?: string;
  submitLabel: string;
  mode: 'create' | 'settings';
  preset?: NativeCliAgentPresetView;
  onSubmit: (a: NativeCliAgentView) => Promise<void>;
  onCancel?: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(agent?.name ?? '');
  const [provider, setProvider] = useState<NativeCliProvider>(agent?.provider ?? 'codex');
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
  const [defaultLaunchMode, setDefaultLaunchMode] = useState<NativeCliLaunchMode>(agent?.defaultLaunchMode ?? 'pty');
  const [appServerTransport, setAppServerTransport] = useState(agent?.appServerTransport ?? '');
  const [adapterSettingsValues, setAdapterSettingsValues] = useState<NativeCliAgentAdapterSettings>(
    agent?.adapterSettings ?? {}
  );
  const [allowAutopilot, setAllowAutopilot] = useState(
    mode === 'settings' && !canProxyApprovals ? true : (agent?.allowAutopilot ?? true)
  );
  const [busy, setBusy] = useState(false);
  const launchModeOptions = agent
    ? nativeCliLaunchModeOptions({ ...agent, defaultLaunchMode }, preset)
    : [defaultLaunchMode];
  const showIdentityFields = mode === 'create';
  const showAdvanced = mode === 'settings';
  const canToggleAutopilot = mode === 'create' || canProxyApprovals;
  const effectiveAllowAutopilot = mode === 'settings' && !canProxyApprovals ? true : allowAutopilot;
  const adapterSettings = agent ? nativeCliAgentSettings({ ...agent, defaultLaunchMode }, preset) : [];

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
          ? (appServerTransport as NativeCliAgentView['appServerTransport'])
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
              placeholder={t('web.nativeCli.namePlaceholder')}
              value={name}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">{t('web.nativeCli.provider')}</Label>
            <Select
              onValueChange={(value) => setProvider(value as NativeCliProvider)}
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
              placeholder={t('web.nativeCli.commandPlaceholder')}
              value={command}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">{t('web.nativeCli.modelOptions')}</Label>
            <textarea
              className="min-h-16 rounded-md border bg-transparent px-2 py-1 font-mono text-xs"
              onChange={(e) => setModelOptions(e.target.value)}
              placeholder={t('web.nativeCli.modelOptionsPlaceholder')}
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
          <Label className="text-xs">{t('web.nativeCli.launchMode')}</Label>
          <Select
            onValueChange={(value) => setDefaultLaunchMode(value as NativeCliLaunchMode)}
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
        templates={projectTemplates}
      />
      {mode === 'create' ? (
        <div className="flex flex-col gap-1">
          <Label className="text-xs">{t('web.nativeCli.autopilot')}</Label>
          <div className="flex items-center gap-2">
            <Switch
              aria-label={t('web.nativeCli.autopilot')}
              checked={effectiveAllowAutopilot}
              disabled={!canToggleAutopilot}
              onCheckedChange={() => setAllowAutopilot((v) => !v)}
            />
            <span className="text-sm">
              {effectiveAllowAutopilot ? t('web.acp.osSandboxOn') : t('web.acp.osSandboxOff')}
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground">{t('web.nativeCli.autopilotHint')}</p>
        </div>
      ) : null}
      {showAdvanced ? (
        <details className="group rounded-md border bg-muted/20">
          <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 font-medium text-xs">
            {t('web.nativeCli.advanced')}
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
  settings: NativeCliAgentSetting[];
  defaultLaunchMode: NativeCliLaunchMode;
  appServerTransport: string;
  adapterSettings: NativeCliAgentAdapterSettings;
  command: string;
  effectiveAllowAutopilot: boolean;
  canToggleAutopilot: boolean;
  setDefaultLaunchMode: (value: NativeCliLaunchMode) => void;
  setAppServerTransport: (value: string) => void;
  setAdapterSettings: Dispatch<SetStateAction<NativeCliAgentAdapterSettings>>;
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
    if (key === 'defaultLaunchMode') setDefaultLaunchMode(value as NativeCliLaunchMode);
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
          const description = nativeCliSettingDescription(setting, { canToggleAutopilot });
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
                  ? t('web.nativeCli.approvalProxyUnavailable')
                  : (description ?? t('web.nativeCli.autopilotHint'))}
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
          placeholder={t('web.nativeCli.argsPlaceholder')}
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
  onChange
}: {
  templates: ProjectTemplateEditorRow[];
  modelOptions: string[];
  onChange: (templates: ProjectTemplateEditorRow[]) => void;
}) {
  const t = useT();
  const updateTemplate = (index: number, patch: Partial<NativeCliProjectTemplate>) => {
    onChange(templates.map((template, i) => (i === index ? { ...template, ...patch } : template)));
  };
  const addTemplate = () => {
    const id = nextTemplateId(templates);
    onChange([...templates, newProjectTemplateEditorRow({ id, displayName: `Template ${templates.length + 1}` })]);
  };
  const removeTemplate = (index: number) => {
    onChange(templates.filter((_, i) => i !== index));
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <Label className="text-xs">{t('web.nativeCli.projectTemplates')}</Label>
          <p className="mt-1 text-[11px] text-muted-foreground">{t('web.nativeCli.projectTemplatesHint')}</p>
        </div>
        <Button
          onClick={addTemplate}
          size="sm"
          type="button"
          variant="outline"
        >
          <HugeiconsIcon icon={PlusSignIcon} />
          {t('web.nativeCli.addProjectTemplate')}
        </Button>
      </div>
      {templates.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-2 text-muted-foreground text-xs">
          {t('web.nativeCli.noProjectTemplates')}
        </p>
      ) : null}
      {templates.map((template, index) => (
        <div
          className="grid gap-2 rounded-md border bg-card p-3"
          key={template.rowKey}
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label className="text-xs">{t('web.nativeCli.projectTemplateId')}</Label>
              <Input
                onChange={(e) => updateTemplate(index, { id: e.target.value })}
                placeholder="reviewer"
                value={template.id}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs">{t('web.nativeCli.projectTemplateDisplayName')}</Label>
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
                  onValueChange={(value) =>
                    updateTemplate(index, { modelId: value === SELECT_EMPTY_VALUE ? undefined : value })
                  }
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
            <div className="flex flex-col gap-1">
              <Label className="text-xs">{t('web.workplace.reasoningEffort')}</Label>
              <Input
                onChange={(e) => updateTemplate(index, { reasoningEffort: e.target.value || undefined })}
                placeholder="high"
                value={template.reasoningEffort ?? ''}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs">{t('web.workplace.enableFastMode')}</Label>
              <Select
                onValueChange={(value) =>
                  updateTemplate(index, {
                    speed: (value === SELECT_EMPTY_VALUE ? undefined : value) as NativeCliProjectTemplate['speed']
                  })
                }
                value={template.speed ?? SELECT_EMPTY_VALUE}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={SELECT_EMPTY_VALUE}>{t('web.nativeCli.projectTemplateStandardSpeed')}</SelectItem>
                  <SelectItem value="fast">{t('web.nativeCli.projectTemplateFastSpeed')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">{t('web.nativeCli.projectTemplatePrompt')}</Label>
            <textarea
              className="min-h-16 rounded-md border bg-transparent px-2 py-1 text-xs"
              onChange={(e) => updateTemplate(index, { customPrompt: e.target.value || undefined })}
              placeholder={t('web.nativeCli.projectTemplatePromptPlaceholder')}
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
      ))}
    </div>
  );
}
