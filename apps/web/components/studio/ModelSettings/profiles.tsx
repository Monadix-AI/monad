'use client';

import type { WebMessageIdWithoutParams } from '@monad/i18n';
import type {
  GenerationParamsView,
  ModelInfo,
  ModelModalities,
  ModelRole,
  ProfileView,
  ProviderView
} from '@monad/protocol';

import { Button, Card, cn, Input, Tooltip, TooltipContent, TooltipTrigger } from '@monad/ui';
import { Brain, Database, Eye, Mic, Star, Trash2, Video, Wand2, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { useProviderMeta } from '@/lib/ProviderMeta';
import { ModelHoverCardBody, ModelPickerPopover, ROLE_NONE, splitModelSpec } from './model-picker';
import { roleFallbackLabelKey } from './role-fallback';

type RoleKey = Exclude<ModelRole, 'chat'>;
type RouteKey = keyof ProfileView['routes'];

const ROLE_DEFS: {
  role: RoleKey;
  labelKey: WebMessageIdWithoutParams;
  match: (c?: ModelModalities) => boolean;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { role: 'vision', labelKey: 'web.model.roleVision', match: (c) => !!c?.input?.includes('image'), icon: Eye },
  {
    role: 'image',
    labelKey: 'web.model.roleImage',
    match: (c) => c?.kind === 'image' || !!c?.output?.includes('image'),
    icon: Wand2
  },
  {
    role: 'video',
    labelKey: 'web.model.roleVideo',
    match: (c) => c?.kind === 'video' || !!c?.output?.includes('video'),
    icon: Video
  },
  {
    role: 'speech',
    labelKey: 'web.model.roleSpeech',
    match: (c) => c?.kind === 'speech' || !!c?.output?.includes('audio'),
    icon: Mic
  },
  { role: 'embedding', labelKey: 'web.model.roleEmbedding', match: (c) => c?.kind === 'embedding', icon: Database },
  {
    role: 'memory',
    labelKey: 'web.model.roleMemory',
    match: (c) => !!c?.input?.includes('text') && !!c?.output?.includes('text'),
    icon: Brain
  }
];

const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;

export function ProfileCard({
  defaultAlias,
  deleteDisabledReason,
  isDraft = false,
  modelsByProvider,
  onDelete,
  onDraftCreate,
  onParamsChange,
  onRouteChange,
  onSetDefault,
  onRename,
  profile,
  providers
}: {
  defaultAlias: string;
  deleteDisabledReason?: string;
  isDraft?: boolean;
  modelsByProvider: Record<string, ModelInfo[]>;
  onDelete: () => void;
  onDraftCreate?: () => void;
  onParamsChange: (params: GenerationParamsView) => void;
  onRouteChange: (role: RouteKey, spec: string) => void;
  onSetDefault: () => void;
  onRename: (alias: string) => void;
  profile: ProfileView;
  providers: ProviderView[];
}) {
  const t = useT();
  const { metaFor } = useProviderMeta();
  const isDefault = !isDraft && profile.alias === defaultAlias;

  const [editingAlias, setEditingAlias] = useState(isDraft);
  const [aliasInput, setAliasInput] = useState(profile.alias);
  const [openModelHover, setOpenModelHover] = useState<string | null>(null);
  const [openModelPicker, setOpenModelPicker] = useState<string | null>(null);

  useEffect(() => {
    setAliasInput(profile.alias);
  }, [profile.alias]);

  const saveAlias = () => {
    const trimmed = aliasInput.trim();
    if (trimmed && trimmed !== profile.alias) onRename(trimmed);
    else setAliasInput(profile.alias);
    setEditingAlias(false);
  };

  const defaultModelEntry =
    profile.routes.chat.provider && profile.routes.chat.modelId
      ? (modelsByProvider[profile.routes.chat.provider] ?? []).find((m) => m.id === profile.routes.chat.modelId)
      : undefined;
  const defaultModelCaps = defaultModelEntry?.modalities;
  const defaultSpec =
    profile.routes.chat.provider && profile.routes.chat.modelId
      ? `${profile.routes.chat.provider}:${profile.routes.chat.modelId}`
      : '';

  const fastModelEntry =
    profile.routes.fast?.provider && profile.routes.fast.modelId
      ? (modelsByProvider[profile.routes.fast.provider] ?? []).find((m) => m.id === profile.routes.fast?.modelId)
      : undefined;
  const fastSpec = profile.routes.fast ? `${profile.routes.fast.provider}:${profile.routes.fast.modelId}` : '';

  const defaultProvMeta = profile.routes.chat.provider
    ? metaFor(providers.find((p) => p.id === profile.routes.chat.provider)?.type ?? '')
    : null;
  const fastProvMeta = profile.routes.fast?.provider
    ? metaFor(providers.find((p) => p.id === profile.routes.fast?.provider)?.type ?? '')
    : null;

  const canCreate =
    isDraft && !!profile.alias.trim() && !!profile.routes.chat.provider && !!profile.routes.chat.modelId;
  const handleModelPickerOpenChange = (key: string, open: boolean) => {
    setOpenModelPicker((current) => {
      if (open) return key;
      return current === key ? null : current;
    });
    if (open) setOpenModelHover(null);
  };
  const handleModelHoverOpenChange = (key: string, open: boolean) => {
    if (open && openModelPicker !== null) return;
    setOpenModelHover(open ? key : null);
  };

  return (
    <Card className="flex flex-col overflow-hidden border-border/70 bg-card p-0">
      <div className="flex h-10 items-center justify-between gap-2 border-border/50 border-b px-3">
        {editingAlias ? (
          <Input
            autoFocus
            className="h-7 flex-1 text-sm"
            onBlur={saveAlias}
            onChange={(e) => setAliasInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveAlias();
              if (e.key === 'Escape') {
                setAliasInput(profile.alias);
                setEditingAlias(false);
              }
            }}
            value={aliasInput}
          />
        ) : (
          <button
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
            onClick={() => {
              setAliasInput(profile.alias);
              setEditingAlias(true);
            }}
            type="button"
          >
            <span className="truncate font-semibold text-sm hover:underline">
              {profile.alias || <span className="font-normal text-muted-foreground italic">Untitled</span>}
            </span>
            {isDefault && (
              <span className="shrink-0 rounded bg-primary/12 px-1.5 py-0.5 font-medium text-[10px] text-primary">
                {t('web.model.default')}
              </span>
            )}
          </button>
        )}
        <div className="flex shrink-0 items-center gap-0.5">
          {!isDefault && !isDraft && (
            <Button
              className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground"
              onClick={onSetDefault}
              size="sm"
              variant="ghost"
            >
              {t('web.model.setDefault')}
            </Button>
          )}
          {isDraft && (
            <>
              <Button
                className="h-6 px-2 text-[11px] text-muted-foreground"
                onClick={onDelete}
                size="sm"
                variant="ghost"
              >
                {t('web.model.cancel')}
              </Button>
              <Button
                className="h-6 px-2 text-[11px]"
                disabled={!canCreate}
                onClick={onDraftCreate}
                size="sm"
              >
                {t('web.save')}
              </Button>
            </>
          )}
          {!isDraft && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Button
                    aria-label={t('web.model.deleteProfile')}
                    className="size-7 text-muted-foreground hover:text-destructive disabled:hover:text-muted-foreground"
                    disabled={!!deleteDisabledReason}
                    onClick={deleteDisabledReason ? undefined : onDelete}
                    size="icon"
                    variant="ghost"
                  >
                    <Trash2 />
                  </Button>
                </span>
              </TooltipTrigger>
              {deleteDisabledReason && <TooltipContent>{deleteDisabledReason}</TooltipContent>}
            </Tooltip>
          )}
        </div>
      </div>

      <div className="flex flex-1 flex-col">
        <div className="border-border/40 border-b px-3 pb-2.5">
          <div className="flex items-start justify-between px-0.5 py-1">
            <span className="mr-3 flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
              <Star className="size-3" />
              {t('web.model.defaultModel')}
            </span>
            <HoverCard
              onOpenChange={(open) => handleModelHoverOpenChange('chat', open)}
              open={openModelPicker === null && openModelHover === 'chat'}
              openDelay={250}
            >
              <ModelPickerPopover
                modelFilter={(m) => !m.modalities?.output || m.modalities.output.includes('text')}
                modelsByProvider={modelsByProvider}
                onOpenChange={(open) => handleModelPickerOpenChange('chat', open)}
                onValueChange={(spec) => onRouteChange('chat', spec)}
                providers={providers}
                value={defaultSpec}
              >
                <HoverCardTrigger asChild>
                  <button
                    className="flex min-w-0 flex-1 items-center justify-end gap-1.5 text-right text-xs transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    type="button"
                  >
                    {defaultProvMeta?.logo && profile.routes.chat.modelId && (
                      <defaultProvMeta.logo className={cn('size-3 shrink-0', defaultProvMeta.color)} />
                    )}
                    {profile.routes.chat.modelId ? (
                      <span className="min-w-0 truncate font-medium">
                        {defaultModelEntry?.label ?? profile.routes.chat.modelId}
                      </span>
                    ) : (
                      <span className="min-w-0 truncate text-muted-foreground italic">
                        {t('web.model.selectModel')}
                      </span>
                    )}
                  </button>
                </HoverCardTrigger>
              </ModelPickerPopover>
              <HoverCardContent
                className="w-72"
                side="top"
              >
                <ModelHoverCardBody model={defaultModelEntry} />
              </HoverCardContent>
            </HoverCard>
          </div>

          <div className="mt-1 flex items-start justify-between px-0.5 py-1">
            <span className="mr-3 flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
              <Zap className="size-3" />
              {t('web.model.fastModel')}
              <HoverCard openDelay={200}>
                <HoverCardTrigger asChild>
                  <button
                    className="inline-flex size-3.5 items-center justify-center rounded-full border border-muted-foreground/40 text-[9px] text-muted-foreground hover:border-muted-foreground/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    type="button"
                  >
                    ?
                  </button>
                </HoverCardTrigger>
                <HoverCardContent
                  className="w-64 text-muted-foreground text-xs"
                  side="top"
                >
                  {t('web.model.fastModelHint')}
                </HoverCardContent>
              </HoverCard>
            </span>
            <HoverCard
              onOpenChange={(open) => handleModelHoverOpenChange('fast', open)}
              open={openModelPicker === null && openModelHover === 'fast'}
              openDelay={250}
            >
              <ModelPickerPopover
                modelFilter={(m) => !m.modalities?.output || m.modalities.output.includes('text')}
                modelsByProvider={modelsByProvider}
                noneLabel={t('web.model.useDefaultModel')}
                onOpenChange={(open) => handleModelPickerOpenChange('fast', open)}
                onValueChange={(spec) => onRouteChange('fast', spec === ROLE_NONE ? '' : spec)}
                providers={providers}
                value={fastSpec || ROLE_NONE}
              >
                <HoverCardTrigger asChild>
                  <button
                    className="flex min-w-0 flex-1 items-center justify-end gap-1.5 text-right text-xs transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    type="button"
                  >
                    {fastProvMeta?.logo && profile.routes.fast?.modelId && (
                      <fastProvMeta.logo className={cn('size-3 shrink-0', fastProvMeta.color)} />
                    )}
                    {profile.routes.fast?.modelId ? (
                      <span className="min-w-0 truncate font-medium">
                        {fastModelEntry?.label ?? profile.routes.fast.modelId}
                      </span>
                    ) : (
                      <span className="min-w-0 truncate text-muted-foreground">{t('web.model.useDefaultModel')}</span>
                    )}
                  </button>
                </HoverCardTrigger>
              </ModelPickerPopover>
              <HoverCardContent
                className="w-72"
                side="top"
              >
                <ModelHoverCardBody model={fastModelEntry} />
              </HoverCardContent>
            </HoverCard>
          </div>
        </div>

        {defaultModelCaps?.reasoning && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-border/40 border-b px-3 py-2">
            <span className="shrink-0 text-[11px] text-muted-foreground">{t('web.model.reasoningEffort')}</span>
            <div className="flex flex-wrap justify-end gap-1">
              {REASONING_EFFORTS.map((level) => {
                const active = (profile.params?.reasoningEffort ?? 'medium') === level;
                return (
                  <button
                    className={cn(
                      'rounded-(--radius-sm) border px-2 py-0.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      active
                        ? 'border-primary bg-primary/10 font-medium text-primary'
                        : 'border-input text-muted-foreground hover:border-ring hover:text-foreground'
                    )}
                    key={level}
                    onClick={() => onParamsChange({ ...profile.params, reasoningEffort: level })}
                    type="button"
                  >
                    {t(
                      `web.model.reasoningEffort${level.charAt(0).toUpperCase()}${level.slice(1)}` as 'web.model.reasoningEffortMinimal'
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="grid gap-1.5 p-3 sm:grid-cols-2">
          {ROLE_DEFS.map(({ role, labelKey, match, icon: RoleIcon }) => {
            const route = profile.routes[role as RoleKey];
            const current = route ? `${route.provider}:${route.modelId}` : '';
            const isSet = !!current;
            const fallbackLabelKey = roleFallbackLabelKey(defaultModelCaps, match);
            const parsed = isSet ? splitModelSpec(current) : null;
            const roleModel = parsed
              ? (modelsByProvider[parsed.providerId] ?? []).find((m) => m.id === parsed.modelId)
              : undefined;
            const roleProvMeta = parsed ? metaFor(providers.find((p) => p.id === parsed.providerId)?.type ?? '') : null;
            return (
              <div
                className="min-w-0 rounded-(--radius-md) bg-muted/20 px-2.5 py-2"
                key={role}
              >
                <div className="mb-1 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                  <RoleIcon className="size-3 shrink-0" />
                  <span className="truncate">{t(labelKey)}</span>
                </div>
                <HoverCard
                  onOpenChange={(open) => handleModelHoverOpenChange(role, open)}
                  open={openModelPicker === null && openModelHover === role}
                  openDelay={250}
                >
                  <ModelPickerPopover
                    modelFilter={(m) => match(m.modalities)}
                    modelsByProvider={modelsByProvider}
                    noneLabel={t(fallbackLabelKey)}
                    onOpenChange={(open) => handleModelPickerOpenChange(role, open)}
                    onValueChange={(spec) => onRouteChange(role, spec === ROLE_NONE ? '' : spec)}
                    providers={providers}
                    value={current || ROLE_NONE}
                  >
                    <HoverCardTrigger asChild>
                      <button
                        className="flex w-full min-w-0 items-center gap-1.5 text-left text-xs transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        type="button"
                      >
                        {isSet && roleProvMeta?.logo && (
                          <roleProvMeta.logo className={cn('size-3 shrink-0', roleProvMeta.color)} />
                        )}
                        {isSet ? (
                          <span className="min-w-0 truncate font-medium">
                            {roleModel?.label ?? parsed?.modelId ?? current}
                          </span>
                        ) : (
                          <span className="min-w-0 truncate text-muted-foreground">{t(fallbackLabelKey)}</span>
                        )}
                      </button>
                    </HoverCardTrigger>
                  </ModelPickerPopover>
                  {isSet && (
                    <HoverCardContent
                      className="w-72"
                      side="top"
                    >
                      <ModelHoverCardBody model={roleModel} />
                    </HoverCardContent>
                  )}
                </HoverCard>
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}
