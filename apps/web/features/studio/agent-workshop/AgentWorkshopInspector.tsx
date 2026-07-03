'use client';

import type { SandboxMode } from '@monad/protocol';

import {
  BrainIcon,
  CheckIcon,
  CircleDashedIcon,
  EyeIcon,
  GlobeIcon,
  PackageIcon,
  Plug01Icon,
  ShieldHalfIcon,
  SparklesIcon,
  UserGroupIcon,
  Wrench01Icon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Button,
  cn,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea
} from '@monad/ui';

import { useT } from '@/components/I18nProvider';
import { Markdown } from '@/components/Markdown';
import { type CapabilityItem, INHERIT, MODEL_ROLES, SANDBOX_MODES, type WorkshopPart } from './AgentWorkshopPrimitives';

interface AgentWorkshopInspectorProps {
  atomsAllow: string[];
  atomsMode: 'inherit' | 'allowlist';
  capabilityCatalog: CapabilityItem[];
  exposed: boolean;
  isPublic: boolean;
  maxBudgetUsd: string;
  maxThinkingTokens: string;
  maxTurns: string;
  model: string;
  profiles: { alias: string }[];
  prompt: string;
  promptMode: 'write' | 'preview';
  roles: Record<string, string>;
  sandboxMode: SandboxMode | '';
  selectedPart: WorkshopPart;
  setAtomsAllow: (value: string[] | ((prev: string[]) => string[])) => void;
  setAtomsMode: (mode: 'inherit' | 'allowlist') => void;
  setIsPublic: (value: boolean) => void;
  setMaxBudgetUsd: (value: string) => void;
  setMaxThinkingTokens: (value: string) => void;
  setMaxTurns: (value: string) => void;
  setModel: (value: string) => void;
  setPrompt: (value: string) => void;
  setPromptMode: (mode: 'write' | 'preview') => void;
  setRoles: (value: Record<string, string> | ((prev: Record<string, string>) => Record<string, string>)) => void;
  setSandboxMode: (value: SandboxMode | '') => void;
  setSubagentCallable: (value: boolean) => void;
  subagentCallable: boolean;
}

export function AgentWorkshopInspector({
  atomsAllow,
  atomsMode,
  capabilityCatalog,
  exposed,
  isPublic,
  maxBudgetUsd,
  maxThinkingTokens,
  maxTurns,
  model,
  profiles,
  prompt,
  promptMode,
  roles,
  sandboxMode,
  selectedPart,
  setAtomsAllow,
  setAtomsMode,
  setIsPublic,
  setMaxBudgetUsd,
  setMaxThinkingTokens,
  setMaxTurns,
  setModel,
  setPrompt,
  setPromptMode,
  setRoles,
  setSandboxMode,
  setSubagentCallable,
  subagentCallable
}: AgentWorkshopInspectorProps) {
  const t = useT();

  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="rounded-2xl border bg-card p-4">
        <div className="flex items-center gap-2">
          <HugeiconsIcon
            className="size-4 text-primary"
            icon={CircleDashedIcon}
          />
          <div>
            <div className="font-medium text-sm">{t('web.studio.workshopInspector')}</div>
            <div className="text-muted-foreground text-xs">{t('web.studio.workshopInspectorHint')}</div>
          </div>
        </div>
      </div>

      {selectedPart === 'brain' && (
        <div className="flex flex-col gap-4 rounded-2xl border bg-card p-4">
          <div className="flex items-center gap-2">
            <HugeiconsIcon
              className="size-4 text-primary"
              icon={BrainIcon}
            />
            <span className="font-medium text-sm">{t('web.studio.workshopBrain')}</span>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="inspector-model">{t('web.studio.model')}</Label>
            <Input
              id="inspector-model"
              onChange={(event) => setModel(event.target.value)}
              placeholder={t('web.studio.modelInherit')}
              value={model}
            />
          </div>
          <div className="flex flex-col gap-3">
            {MODEL_ROLES.map(({ key, label, hint }) => (
              <div
                className="grid gap-2"
                key={key}
              >
                <div className="font-medium text-sm">{label}</div>
                <Select
                  onValueChange={(value) =>
                    setRoles((prev) => {
                      const next = { ...prev };
                      if (value === INHERIT) delete next[key];
                      else next[key] = value;
                      return next;
                    })
                  }
                  value={roles[key] ?? INHERIT}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={INHERIT}>{t('web.studio.workshopInheritGlobal')}</SelectItem>
                    {profiles.map((profile) => (
                      <SelectItem
                        key={profile.alias}
                        value={profile.alias}
                      >
                        {profile.alias}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="text-muted-foreground text-xs">{hint}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {selectedPart === 'prompt' && (
        <div className="flex flex-col gap-4 rounded-2xl border bg-card p-4">
          <div className="flex items-center gap-2">
            <HugeiconsIcon
              className="size-4 text-primary"
              icon={SparklesIcon}
            />
            <span className="font-medium text-sm">{t('web.studio.workshopPrompt')}</span>
          </div>
          <div className="flex w-fit items-center gap-1 rounded-full border p-1 text-xs">
            {(['write', 'preview'] as const).map((mode) => (
              <button
                className={cn(
                  'rounded-full px-3 py-1.5 transition',
                  promptMode === mode ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'
                )}
                key={mode}
                onClick={() => setPromptMode(mode)}
                type="button"
              >
                {mode === 'write' ? t('web.studio.write') : t('web.studio.preview')}
              </button>
            ))}
          </div>
          {promptMode === 'write' ? (
            <Textarea
              className="min-h-72 resize-none font-mono text-[13px] leading-relaxed"
              onChange={(event) => setPrompt(event.target.value)}
              placeholder={t('web.studio.promptHint')}
              value={prompt}
            />
          ) : (
            <div className="min-h-72 rounded-2xl border bg-background/70 p-4">
              <Markdown text={prompt || t('web.studio.promptEmpty')} />
            </div>
          )}
        </div>
      )}

      {selectedPart === 'tools' && (
        <div className="flex flex-col gap-4 rounded-2xl border bg-card p-4">
          <div className="flex items-center gap-2">
            <HugeiconsIcon
              className="size-4 text-primary"
              icon={Wrench01Icon}
            />
            <span className="font-medium text-sm">{t('web.studio.workshopTools')}</span>
          </div>
          <div className="flex items-center gap-3 rounded-2xl border bg-background/80 px-4 py-3">
            <div className="flex-1">
              <div className="font-medium text-sm">{t('web.studio.atomsAllowlist')}</div>
              <div className="text-muted-foreground text-xs">{t('web.studio.atomsModeDesc')}</div>
            </div>
            <Switch
              checked={atomsMode === 'allowlist'}
              onCheckedChange={(checked) => setAtomsMode(checked ? 'allowlist' : 'inherit')}
            />
          </div>
          <div className="flex flex-col gap-2">
            {capabilityCatalog.map((capability) => {
              const checked = atomsAllow.includes(capability.name);
              return (
                <div
                  className="flex items-center gap-3 rounded-2xl border bg-background/70 px-3 py-3"
                  key={capability.name}
                >
                  <span className="flex size-8 items-center justify-center rounded-xl bg-secondary text-secondary-foreground">
                    {capability.sourceKind === 'atom' ? (
                      <HugeiconsIcon
                        className="size-4"
                        icon={PackageIcon}
                      />
                    ) : (
                      <HugeiconsIcon
                        className="size-4"
                        icon={Plug01Icon}
                      />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-sm">{capability.name}</div>
                    <div className="truncate text-muted-foreground text-xs">{capability.detail}</div>
                  </div>
                  <Switch
                    checked={checked}
                    disabled={atomsMode !== 'allowlist'}
                    onCheckedChange={(on) =>
                      setAtomsAllow((prev) =>
                        on
                          ? [...new Set([...prev, capability.name])]
                          : prev.filter((value) => value !== capability.name)
                      )
                    }
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {selectedPart === 'safety' && (
        <div className="flex flex-col gap-4 rounded-2xl border bg-card p-4">
          <div className="flex items-center gap-2">
            <HugeiconsIcon
              className="size-4 text-primary"
              icon={ShieldHalfIcon}
            />
            <span className="font-medium text-sm">{t('web.studio.workshopSafety')}</span>
          </div>
          <div className="flex flex-col gap-2">
            <Label>{t('web.studio.sandboxMode')}</Label>
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => setSandboxMode('')}
                size="sm"
                variant={sandboxMode === '' ? 'secondary' : 'outline'}
              >
                {t('web.studio.sandboxInherit')}
              </Button>
              {SANDBOX_MODES.map((mode) => (
                <Button
                  key={mode}
                  onClick={() => setSandboxMode(mode)}
                  size="sm"
                  variant={sandboxMode === mode ? 'secondary' : 'outline'}
                >
                  {mode}
                </Button>
              ))}
            </div>
            <div className="text-muted-foreground text-xs">{t('web.studio.sandboxHelp')}</div>
          </div>
          <div className="grid gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="agent-maxTurns">{t('web.studio.maxTurns')}</Label>
              <Input
                id="agent-maxTurns"
                onChange={(event) => setMaxTurns(event.target.value)}
                placeholder={t('web.studio.maxTurnsHint')}
                type="number"
                value={maxTurns}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="agent-maxThinkingTokens">{t('web.studio.maxThinkingTokens')}</Label>
              <Input
                id="agent-maxThinkingTokens"
                onChange={(event) => setMaxThinkingTokens(event.target.value)}
                placeholder={t('web.studio.maxThinkingTokensHint')}
                type="number"
                value={maxThinkingTokens}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="agent-maxBudgetUsd">{t('web.studio.maxBudgetUsd')}</Label>
              <Input
                id="agent-maxBudgetUsd"
                onChange={(event) => setMaxBudgetUsd(event.target.value)}
                placeholder={t('web.studio.maxBudgetUsdHint')}
                step="0.0001"
                type="number"
                value={maxBudgetUsd}
              />
            </div>
          </div>
        </div>
      )}

      {selectedPart === 'visibility' && (
        <div className="flex flex-col gap-4 rounded-2xl border bg-card p-4">
          <div className="flex items-center gap-2">
            <HugeiconsIcon
              className="size-4 text-primary"
              icon={EyeIcon}
            />
            <span className="font-medium text-sm">{t('web.studio.workshopVisibility')}</span>
          </div>
          <div className="rounded-2xl border bg-background/80 px-4 py-3">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex size-8 items-center justify-center rounded-xl bg-secondary text-secondary-foreground">
                <HugeiconsIcon
                  className="size-4"
                  icon={CheckIcon}
                />
              </span>
              <div>
                <div className="font-medium text-sm">{t('web.studio.visStandalone')}</div>
                <div className="text-muted-foreground text-xs">{t('web.studio.visStandaloneDesc')}</div>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-2xl border bg-background/80 px-4 py-3">
            <HugeiconsIcon
              className="size-4 text-primary"
              icon={UserGroupIcon}
            />
            <div className="flex-1">
              <div className="font-medium text-sm">{t('web.studio.visSubagent')}</div>
              <div className="text-muted-foreground text-xs">{t('web.studio.visSubagentDesc')}</div>
            </div>
            <Switch
              checked={subagentCallable}
              onCheckedChange={setSubagentCallable}
            />
          </div>
          <div className="flex items-center gap-3 rounded-2xl border bg-background/80 px-4 py-3">
            <HugeiconsIcon
              className="size-4 text-primary"
              icon={GlobeIcon}
            />
            <div className="flex-1">
              <div className="font-medium text-sm">{t('web.studio.visPublic')}</div>
              <div className="text-muted-foreground text-xs">{t('web.studio.visPublicDesc')}</div>
            </div>
            <Switch
              checked={isPublic}
              onCheckedChange={setIsPublic}
            />
          </div>
          {exposed && (
            <div className="rounded-2xl border border-warning/40 bg-warning/10 px-4 py-3 text-xs leading-relaxed">
              {t('web.studio.exposeWarning')}
            </div>
          )}
        </div>
      )}

      <div className="rounded-2xl border bg-card p-4">
        <div className="flex items-center gap-2 text-muted-foreground text-xs">
          <HugeiconsIcon
            className="size-3.5 text-primary"
            icon={ShieldHalfIcon}
          />
          {t('web.studio.exposeSubset')}
        </div>
      </div>
    </div>
  );
}
