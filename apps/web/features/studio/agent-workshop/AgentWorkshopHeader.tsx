'use client';

import type { WebMessageIdWithoutParams } from '@monad/i18n';
import type { WorkshopPart } from './AgentWorkshopPrimitives';

import { SparklesIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Badge, Button, cn, Input, Label } from '@monad/ui';

import { useT } from '#/components/I18nProvider';
import { useAgentWorkshopStore } from './agent-workshop-store';

interface AgentWorkshopHeaderProps {
  allowCount: number;
  exposed: boolean;
  nextAssemblyPart: WorkshopPart | null;
  partCompletion: { active: boolean; label: string; part: WorkshopPart }[];
  partsInstalled: number;
  readinessKey: WebMessageIdWithoutParams;
}

export function AgentWorkshopHeader({
  allowCount,
  exposed,
  nextAssemblyPart,
  partCompletion,
  partsInstalled,
  readinessKey
}: AgentWorkshopHeaderProps) {
  const t = useT();
  const a2aEnabled = useAgentWorkshopStore((state) => state.a2aEnabled);
  const atomsMode = useAgentWorkshopStore((state) => state.atomsMode);
  const description = useAgentWorkshopStore((state) => state.description);
  const isPublic = useAgentWorkshopStore((state) => state.isPublic);
  const model = useAgentWorkshopStore((state) => state.model);
  const name = useAgentWorkshopStore((state) => state.name);
  const sandboxMode = useAgentWorkshopStore((state) => state.sandboxMode);
  const setDescription = useAgentWorkshopStore((state) => state.setDescription);
  const setModel = useAgentWorkshopStore((state) => state.setModel);
  const setName = useAgentWorkshopStore((state) => state.setName);
  const setSelectedPart = useAgentWorkshopStore((state) => state.setSelectedPart);
  const subagentCallable = useAgentWorkshopStore((state) => state.subagentCallable);
  const nextPartLabel = nextAssemblyPart ? partCompletion.find(({ part }) => part === nextAssemblyPart)?.label : null;

  return (
    <div className="border-b px-5 py-4">
      <div className="grid gap-3 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-2xl border bg-card p-5">
          <div className="mb-4 flex items-center gap-2">
            <HugeiconsIcon
              className="size-4 text-primary"
              icon={SparklesIcon}
            />
            <span className="font-medium text-sm">{t('web.studio.workshopIdentity')}</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-[1fr_220px]">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="agent-name">{t('web.studio.name')}</Label>
              <Input
                id="agent-name"
                onChange={(event) => setName(event.target.value)}
                value={name}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="agent-model">{t('web.studio.model')}</Label>
              <Input
                id="agent-model"
                onChange={(event) => setModel(event.target.value)}
                placeholder={t('web.studio.modelInherit')}
                value={model}
              />
            </div>
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="agent-desc">{t('web.studio.description')}</Label>
              <Input
                id="agent-desc"
                onChange={(event) => setDescription(event.target.value)}
                placeholder={t('web.studio.descriptionHint')}
                value={description}
              />
            </div>
          </div>
        </div>

        <div className="rounded-2xl border bg-card p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="font-medium text-sm">{t('web.studio.workshopPreview')}</div>
              <div className="mt-1 text-muted-foreground text-xs">{t('web.studio.workshopPreviewHint')}</div>
            </div>
            <Badge variant="secondary">{t(readinessKey)}</Badge>
          </div>
          <fieldset className="mt-4 flex items-center gap-1.5">
            <legend className="sr-only">{t('web.studio.workshopAssemblyProgress')}</legend>
            {partCompletion.map(({ active, label, part }) => (
              <button
                aria-label={label}
                className={cn(
                  'h-2 flex-1 rounded-full transition',
                  active ? 'bg-primary shadow-[0_0_16px_theme(colors.primary/35)]' : 'bg-muted'
                )}
                key={part}
                onClick={() => setSelectedPart(part)}
                title={label}
                type="button"
              />
            ))}
          </fieldset>
          <div className="mt-4 flex items-center gap-3 rounded-2xl border bg-background/80 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="text-[11px] text-muted-foreground uppercase tracking-wide">
                {nextAssemblyPart ? t('web.studio.workshopNextInstall') : t('web.studio.workshopAssemblyComplete')}
              </div>
              <div className="mt-1 truncate font-medium text-sm">
                {nextPartLabel ?? t('web.studio.workshopAssemblyCompleteHint')}
              </div>
            </div>
            {nextAssemblyPart && (
              <Button
                onClick={() => setSelectedPart(nextAssemblyPart)}
                size="sm"
                variant="outline"
              >
                {t('web.studio.workshopOpenNext')}
              </Button>
            )}
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <div className="rounded-2xl border bg-background/80 px-3 py-2">
              <div className="text-[11px] text-muted-foreground uppercase tracking-wide">
                {t('web.studio.workshopPreviewParts')}
              </div>
              <div className="mt-1 font-medium text-sm">{partsInstalled}/5</div>
            </div>
            <div className="rounded-2xl border bg-background/80 px-3 py-2">
              <div className="text-[11px] text-muted-foreground uppercase tracking-wide">
                {t('web.studio.workshopPreviewTools')}
              </div>
              <div className="mt-1 font-medium text-sm">
                {atomsMode === 'allowlist'
                  ? t('web.studio.workshopPreviewAllowlist', { count: allowCount })
                  : t('web.studio.workshopPreviewSystemWide')}
              </div>
            </div>
            <div className="rounded-2xl border bg-background/80 px-3 py-2">
              <div className="text-[11px] text-muted-foreground uppercase tracking-wide">
                {t('web.studio.workshopPreviewSandbox')}
              </div>
              <div className="mt-1 font-medium text-sm">{sandboxMode || t('web.studio.sandboxInherit')}</div>
            </div>
            <div className="rounded-2xl border bg-background/80 px-3 py-2">
              <div className="text-[11px] text-muted-foreground uppercase tracking-wide">
                {t('web.studio.workshopPreviewExposure')}
              </div>
              <div className="mt-1 font-medium text-sm">
                {exposed
                  ? [
                      subagentCallable ? t('web.studio.badgeSubagent') : null,
                      isPublic ? t('web.studio.badgePublic') : null,
                      a2aEnabled ? t('web.studio.badgeA2a') : null
                    ]
                      .filter(Boolean)
                      .join(' + ')
                  : t('web.studio.visStandalone')}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
