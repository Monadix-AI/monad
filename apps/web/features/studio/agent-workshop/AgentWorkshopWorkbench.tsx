'use client';

import type { SandboxMode } from '@monad/protocol';
import type { DragEvent } from 'react';

import { BrainIcon, EyeIcon, ShieldHalfIcon, SparklesIcon, Wrench01Icon } from '@hugeicons/core-free-icons';
import { Badge, ScrollArea } from '@monad/ui';

import { useT } from '@/components/I18nProvider';
import { type WorkshopPart, WorkshopSlot } from './AgentWorkshopPrimitives';

interface AgentWorkshopWorkbenchProps {
  a2aEnabled: boolean;
  atomsAllow: string[];
  atomsMode: 'inherit' | 'allowlist';
  draggingPart: WorkshopPart | null;
  exposed: boolean;
  isPublic: boolean;
  maxBudgetUsd: string;
  maxThinkingTokens: string;
  maxTurns: string;
  model: string;
  onDrop: (part: WorkshopPart, event: DragEvent<HTMLButtonElement | HTMLDivElement>) => void;
  prompt: string;
  roleCount: number;
  safetyConfigured: boolean;
  sandboxMode: SandboxMode | '';
  selectedPart: WorkshopPart;
  setSelectedPart: (part: WorkshopPart) => void;
  subagentCallable: boolean;
  toolsConfigured: boolean;
}

export function AgentWorkshopWorkbench({
  a2aEnabled,
  atomsAllow,
  atomsMode,
  draggingPart,
  exposed,
  isPublic,
  maxBudgetUsd,
  maxThinkingTokens,
  maxTurns,
  model,
  onDrop,
  prompt,
  roleCount,
  safetyConfigured,
  sandboxMode,
  selectedPart,
  setSelectedPart,
  subagentCallable,
  toolsConfigured
}: AgentWorkshopWorkbenchProps) {
  const t = useT();

  return (
    <ScrollArea>
      <div className="flex flex-col gap-4 p-5">
        <WorkshopSlot
          active={selectedPart === 'brain'}
          body={
            <>
              <div className="font-medium">{model || t('web.studio.modelInherit')}</div>
              <div className="mt-2 text-muted-foreground text-xs">
                {roleCount > 0
                  ? t('web.studio.workshopRoleOverrides', { count: roleCount })
                  : t('web.studio.workshopNoRoleOverrides')}
              </div>
            </>
          }
          dragging={draggingPart === 'brain'}
          icon={BrainIcon}
          onDrop={onDrop}
          onSelect={() => setSelectedPart('brain')}
          part="brain"
          summary={model || roleCount ? t('web.studio.workshopMounted') : t('web.studio.workshopNeedsPart')}
          title={t('web.studio.workshopBrain')}
        />

        <WorkshopSlot
          active={selectedPart === 'prompt'}
          body={
            <div className="flex flex-col gap-2">
              <div className="text-muted-foreground text-xs">
                {prompt.trim() ? t('web.studio.workshopPromptReady') : t('web.studio.workshopPromptEmpty')}
              </div>
              <div className="line-clamp-3 rounded-2xl border bg-background/70 px-3 py-2 font-mono text-[12px] leading-relaxed">
                {prompt.trim() || t('web.studio.promptEmpty')}
              </div>
            </div>
          }
          dragging={draggingPart === 'prompt'}
          icon={SparklesIcon}
          onDrop={onDrop}
          onSelect={() => setSelectedPart('prompt')}
          part="prompt"
          summary={prompt.trim() ? t('web.studio.workshopMounted') : t('web.studio.workshopNeedsPart')}
          title={t('web.studio.workshopPrompt')}
        />

        <WorkshopSlot
          active={selectedPart === 'tools'}
          body={
            <div className="flex flex-col gap-2">
              <div className="text-muted-foreground text-xs">
                {atomsMode === 'allowlist'
                  ? t('web.studio.workshopAllowlistEnabled', { count: atomsAllow.length })
                  : t('web.studio.workshopAllowlistDisabled')}
              </div>
              <div className="flex flex-wrap gap-2">
                {atomsMode === 'allowlist' && atomsAllow.length > 0 ? (
                  atomsAllow.map((value) => (
                    <Badge
                      key={value}
                      variant="secondary"
                    >
                      {value}
                    </Badge>
                  ))
                ) : (
                  <Badge variant="outline">{t('web.studio.workshopDropCapability')}</Badge>
                )}
              </div>
            </div>
          }
          dragging={draggingPart === 'tools'}
          icon={Wrench01Icon}
          onDrop={onDrop}
          onSelect={() => setSelectedPart('tools')}
          part="tools"
          summary={toolsConfigured ? t('web.studio.workshopMounted') : t('web.studio.workshopNeedsPart')}
          title={t('web.studio.workshopTools')}
        />

        <WorkshopSlot
          active={selectedPart === 'safety'}
          body={
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-2xl border bg-background/70 px-3 py-2">
                <div className="text-[11px] text-muted-foreground uppercase tracking-wide">
                  {t('web.studio.sandboxMode')}
                </div>
                <div className="mt-1 font-medium text-sm">{sandboxMode || t('web.studio.sandboxInherit')}</div>
              </div>
              <div className="rounded-2xl border bg-background/70 px-3 py-2">
                <div className="text-[11px] text-muted-foreground uppercase tracking-wide">
                  {t('web.studio.tabBudget')}
                </div>
                <div className="mt-1 font-medium text-sm">
                  {[maxTurns || null, maxThinkingTokens || null, maxBudgetUsd || null].filter(Boolean).length > 0
                    ? t('web.studio.workshopBudgetConfigured')
                    : t('web.studio.workshopBudgetInherited')}
                </div>
              </div>
            </div>
          }
          dragging={draggingPart === 'safety'}
          icon={ShieldHalfIcon}
          onDrop={onDrop}
          onSelect={() => setSelectedPart('safety')}
          part="safety"
          summary={safetyConfigured ? t('web.studio.workshopMounted') : t('web.studio.workshopNeedsPart')}
          title={t('web.studio.workshopSafety')}
        />

        <WorkshopSlot
          active={selectedPart === 'visibility'}
          body={
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">{t('web.studio.visStandalone')}</Badge>
              {subagentCallable && <Badge variant="secondary">{t('web.studio.badgeSubagent')}</Badge>}
              {isPublic && <Badge variant="secondary">{t('web.studio.badgePublic')}</Badge>}
              {a2aEnabled && <Badge variant="secondary">{t('web.studio.badgeA2a')}</Badge>}
            </div>
          }
          dragging={draggingPart === 'visibility'}
          icon={EyeIcon}
          onDrop={onDrop}
          onSelect={() => setSelectedPart('visibility')}
          part="visibility"
          summary={exposed ? t('web.studio.workshopMounted') : t('web.studio.workshopNeedsPart')}
          title={t('web.studio.workshopVisibility')}
        />
      </div>
    </ScrollArea>
  );
}
