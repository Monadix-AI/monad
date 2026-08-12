import type {
  MeshAgentAdapterSettings,
  MeshAgentPresetView,
  MeshAgentProvider,
  MeshAgentSetting,
  MeshAgentView
} from '@monad/protocol';
import type { Dispatch, SetStateAction } from 'react';

import { Cancel01Icon, LoaderPinwheelIcon, PlusSignIcon, SaveIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button, cn, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@monad/ui';
import { useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { DialogBody, DialogFooter } from '#/components/ui/dialog';
import { SwitchSetting } from '#/components/ui/switch-setting';
import { canDisableAutopilot, meshAgentSettingDescription, meshAgentSettings } from './mesh-agent-settings-model';
import {
  argsToStr,
  envToStr,
  modelOptionsToStr,
  strToArgs,
  strToEnv,
  strToModelOptions
} from './mesh-agent-settings-utils';
import './mesh-agent-form.css';

const SELECT_EMPTY_VALUE = '__monad_empty__';

export function AgentForm({
  agent,
  title,
  submitLabel,
  mode,
  preset,
  onSubmit,
  onCancel,
  appearance = 'default',
  layout = 'default'
}: {
  agent?: MeshAgentView;
  title?: string;
  submitLabel: string;
  mode: 'create' | 'settings';
  preset?: MeshAgentPresetView;
  onSubmit: (a: MeshAgentView) => Promise<void>;
  onCancel?: () => void;
  appearance?: 'default' | 'quiet';
  layout?: 'default' | 'dialog';
}) {
  const t = useT();
  const [name, setName] = useState(agent?.name ?? '');
  const [provider, setProvider] = useState<MeshAgentProvider>(agent?.provider ?? 'codex');
  const [command, setCommand] = useState(agent?.command ?? '');
  const [args, setArgs] = useState(argsToStr(agent?.args));
  const [modelOptions, setModelOptions] = useState(modelOptionsToStr(agent?.modelOptions));
  const [env, setEnv] = useState(envToStr(agent?.env));
  const canProxyApprovals = agent ? canDisableAutopilot(agent, preset) : false;
  const [adapterSettingsValues, setAdapterSettingsValues] = useState<MeshAgentAdapterSettings>(
    agent?.adapterSettings ?? {}
  );
  const [allowAutopilot, setAllowAutopilot] = useState(
    mode === 'settings' && !canProxyApprovals ? true : (agent?.allowAutopilot ?? true)
  );
  const [busy, setBusy] = useState(false);
  const showIdentityFields = mode === 'create';
  const showAdvanced = mode === 'settings';
  const canToggleAutopilot = mode === 'create' || canProxyApprovals;
  const effectiveAllowAutopilot = mode === 'settings' && !canProxyApprovals ? true : allowAutopilot;
  const adapterSettings = agent ? meshAgentSettings(agent, preset) : [];

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
        enabled: agent?.enabled ?? true,
        allowAutopilot: effectiveAllowAutopilot,
        approvalOwnership: 'provider-owned',
        capabilities: agent?.capabilities,
        adapterSettings: Object.keys(adapterSettingsValues).length ? adapterSettingsValues : undefined
      });
    } finally {
      setBusy(false);
    }
  };

  const wrapper = cn(
    title ? 'flex flex-col gap-3 rounded-md border border-primary/30 bg-primary/5 p-3' : 'flex flex-col gap-3',
    appearance === 'quiet' && !title && 'mesh-agent-form--quiet'
  );
  const FormContainer = layout === 'dialog' ? DialogBody : 'div';

  return (
    <>
      <FormContainer className={wrapper}>
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
                placeholder={t('web.meshAgent.namePlaceholder')}
                value={name}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs">{t('web.meshAgent.provider')}</Label>
              <Select
                onValueChange={(value) => setProvider(value as MeshAgentProvider)}
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
                placeholder={t('web.meshAgent.commandPlaceholder')}
                value={command}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs">{t('web.meshAgent.modelOptions')}</Label>
              <textarea
                className="min-h-16 rounded-md border bg-transparent px-2 py-1 font-code text-xs"
                onChange={(e) => setModelOptions(e.target.value)}
                placeholder={t('web.meshAgent.modelOptionsPlaceholder')}
                value={modelOptions}
              />
            </div>
          </>
        ) : null}
        {mode === 'settings' ? (
          <AdapterSettingsFields
            adapterSettings={adapterSettingsValues}
            canToggleAutopilot={canToggleAutopilot}
            command={command}
            effectiveAllowAutopilot={effectiveAllowAutopilot}
            setAdapterSettings={setAdapterSettingsValues}
            setAllowAutopilot={setAllowAutopilot}
            setCommand={setCommand}
            settings={adapterSettings}
          />
        ) : null}
        {mode === 'create' ? (
          <SwitchSetting
            checked={effectiveAllowAutopilot}
            className="rounded-md border px-3 py-2.5"
            description={t('web.meshAgent.autopilotHint')}
            disabled={!canToggleAutopilot}
            onCheckedChange={setAllowAutopilot}
            title={t('web.meshAgent.autopilot')}
          />
        ) : null}
        {showAdvanced ? (
          <details className="mesh-agent-form__advanced group rounded-md border bg-muted/20">
            <summary className="flex list-none items-center justify-between px-3 py-2 font-medium text-xs">
              {t('web.meshAgent.advanced')}
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

        {layout !== 'dialog' ? (
          <Button
            className={cn('self-start', appearance === 'quiet' && 'mesh-agent-form__submit--quiet')}
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
        ) : null}
      </FormContainer>
      {layout === 'dialog' ? (
        <DialogFooter>
          {onCancel ? (
            <Button
              onClick={onCancel}
              size="sm"
              variant="outline"
            >
              {t('web.common.cancel')}
            </Button>
          ) : null}
          <Button
            disabled={busy || !name.trim() || !command.trim()}
            onClick={submit}
            size="sm"
          >
            {busy ? (
              <HugeiconsIcon
                className="animate-spin"
                icon={LoaderPinwheelIcon}
              />
            ) : (
              <HugeiconsIcon icon={SaveIcon} />
            )}{' '}
            {submitLabel}
          </Button>
        </DialogFooter>
      ) : null}
    </>
  );
}

function AdapterSettingsFields({
  settings,
  adapterSettings,
  command,
  effectiveAllowAutopilot,
  canToggleAutopilot,
  setAdapterSettings,
  setAllowAutopilot,
  setCommand
}: {
  settings: MeshAgentSetting[];
  adapterSettings: MeshAgentAdapterSettings;
  command: string;
  effectiveAllowAutopilot: boolean;
  canToggleAutopilot: boolean;
  setAdapterSettings: Dispatch<SetStateAction<MeshAgentAdapterSettings>>;
  setAllowAutopilot: Dispatch<SetStateAction<boolean>>;
  setCommand: (value: string) => void;
}) {
  const t = useT();

  const stringValue = (key: string): string => {
    if (key === 'command') return command;
    const value = adapterSettings[key];
    if (typeof value === 'string') return value;
    return '';
  };
  const setStringValue = (key: string, value: string) => {
    if (key === 'command') setCommand(value);
    if (key !== 'command') {
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
      {settings.map((setting) => {
        if (setting.kind === 'switch') {
          const checked =
            setting.key === 'allowAutopilot' ? effectiveAllowAutopilot : adapterSettings[setting.key] === true;
          const description = meshAgentSettingDescription(setting, { canToggleAutopilot });
          return (
            <SwitchSetting
              checked={checked}
              className="rounded-md border px-3 py-2.5"
              description={
                description === 'approvalProxyUnavailable'
                  ? t('web.meshAgent.approvalProxyUnavailable')
                  : (description ?? t('web.meshAgent.autopilotHint'))
              }
              disabled={setting.key === 'allowAutopilot' && !canToggleAutopilot}
              key={setting.key}
              onCheckedChange={(nextChecked) => {
                if (setting.key === 'allowAutopilot') {
                  setAllowAutopilot(nextChecked);
                  return;
                }
                setAdapterSettings((current) => ({ ...current, [setting.key]: nextChecked }));
              }}
              title={setting.label}
            />
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
                className="min-h-16 rounded-md border bg-transparent px-2 py-1 font-ui text-xs"
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
          placeholder={t('web.meshAgent.argsPlaceholder')}
          value={args}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label className="text-xs">{t('web.acp.env')}</Label>
        <textarea
          className="min-h-16 rounded-md border bg-transparent px-2 py-1 font-code text-xs"
          onChange={(e) => setEnv(e.target.value)}
          placeholder={t('web.acp.envPlaceholder')}
          value={env}
        />
      </div>
    </>
  );
}
