import type {
  NativeCliAgentPresetView,
  NativeCliAgentView,
  NativeCliLaunchMode,
  NativeCliProjectTemplate,
  NativeCliProvider
} from '@monad/protocol';

import {
  Cancel01Icon,
  LoaderPinwheelIcon,
  PlusSignIcon,
  SaveIcon,
  ShieldQuestionMarkIcon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button, Input, Label } from '@monad/ui';
import { useState } from 'react';

import { useT } from '@/components/I18nProvider';
import {
  canDisableAutopilot,
  nativeCliAppServerTransportOptions,
  nativeCliLaunchModeOptions
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
  const [allowAutopilot, setAllowAutopilot] = useState(
    mode === 'settings' && !canProxyApprovals ? true : (agent?.allowAutopilot ?? true)
  );
  const [busy, setBusy] = useState(false);
  const launchModeOptions = agent
    ? nativeCliLaunchModeOptions({ ...agent, defaultLaunchMode }, preset)
    : [defaultLaunchMode];
  const appServerTransportOptions = nativeCliAppServerTransportOptions(preset);
  const showIdentityFields = mode === 'create';
  const showAdvanced = mode === 'settings';
  const canToggleAutopilot = mode === 'create' || canProxyApprovals;
  const effectiveAllowAutopilot = mode === 'settings' && !canProxyApprovals ? true : allowAutopilot;

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
        capabilities: agent?.capabilities
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
            <select
              className="rounded-md border bg-transparent px-2 py-2 text-sm"
              onChange={(e) => setProvider(e.target.value as NativeCliProvider)}
              value={provider}
            >
              <option value="codex">Codex</option>
              <option value="claude-code">Claude Code</option>
              <option value="gemini">Gemini</option>
              <option value="qwen">Qwen Code</option>
            </select>
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
      <div className="flex flex-col gap-1">
        <Label className="text-xs">{t('web.nativeCli.launchMode')}</Label>
        <select
          className="rounded-md border bg-transparent px-2 py-2 text-sm"
          onChange={(e) => setDefaultLaunchMode(e.target.value as NativeCliLaunchMode)}
          value={defaultLaunchMode}
        >
          {launchModeOptions.map((launchMode) => (
            <option
              key={launchMode}
              value={launchMode}
            >
              {launchMode}
            </option>
          ))}
        </select>
      </div>
      <ProjectTemplatesEditor
        modelOptions={strToModelOptions(modelOptions)}
        onChange={setProjectTemplates}
        templates={projectTemplates}
      />
      <div className="flex flex-col gap-1">
        <Label className="text-xs">{t('web.nativeCli.autopilot')}</Label>
        <Button
          className="self-start"
          disabled={!canToggleAutopilot}
          onClick={() => setAllowAutopilot((v) => !v)}
          size="sm"
          type="button"
          variant={effectiveAllowAutopilot ? 'secondary' : 'outline'}
        >
          <HugeiconsIcon icon={ShieldQuestionMarkIcon} />{' '}
          {effectiveAllowAutopilot ? t('web.acp.osSandboxOn') : t('web.acp.osSandboxOff')}
        </Button>
        <p className="text-[11px] text-muted-foreground">
          {mode === 'settings' && !canProxyApprovals
            ? t('web.nativeCli.approvalProxyUnavailable')
            : t('web.nativeCli.autopilotHint')}
        </p>
      </div>
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
            {defaultLaunchMode === 'app-server' && appServerTransportOptions.length > 0 ? (
              <div className="flex flex-col gap-1">
                <Label className="text-xs">{t('web.workplace.appServerTransport')}</Label>
                <select
                  className="rounded-md border bg-transparent px-2 py-2 text-sm"
                  onChange={(e) => setAppServerTransport(e.target.value)}
                  value={appServerTransport}
                >
                  <option value="">{t('web.workplace.appServerTransportDefault')}</option>
                  {appServerTransportOptions.map((transport) => (
                    <option
                      key={transport}
                      value={transport}
                    >
                      {transport}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
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
                <select
                  className="rounded-md border bg-transparent px-2 py-2 text-sm"
                  onChange={(e) => updateTemplate(index, { modelId: e.target.value || undefined })}
                  value={template.modelId ?? ''}
                >
                  <option value="">{t('web.workplace.defaultModel')}</option>
                  {modelOptions.map((model) => (
                    <option
                      key={model}
                      value={model}
                    >
                      {model}
                    </option>
                  ))}
                </select>
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
              <select
                className="rounded-md border bg-transparent px-2 py-2 text-sm"
                onChange={(e) =>
                  updateTemplate(index, {
                    speed: (e.target.value || undefined) as NativeCliProjectTemplate['speed']
                  })
                }
                value={template.speed ?? ''}
              >
                <option value="">{t('web.nativeCli.projectTemplateStandardSpeed')}</option>
                <option value="fast">{t('web.nativeCli.projectTemplateFastSpeed')}</option>
              </select>
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
