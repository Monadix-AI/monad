import type { WebMessageIdWithoutParams } from '@monad/i18n/browser';
import type {
  GenerationParamsView,
  ModelInfo,
  ModelModalities,
  ModelRole,
  ProfileView,
  ProviderView
} from '@monad/protocol';

import { Delete02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button, Card, cn, Input, Tooltip, TooltipContent, TooltipTrigger } from '@monad/ui';
import { useEffect, useState } from 'react';

import { ProfileCardHoverActions } from '#/components/HoverActions';
import { useT } from '#/components/I18nProvider';
import {
  ReasoningEffortControl,
  reasoningEffortOption,
  resolveReasoningEffort
} from '#/components/ReasoningEffortControl';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '#/components/ui/hover-card';
import { Popover, PopoverContent, PopoverTrigger } from '#/components/ui/popover';
import { useProviderMeta } from '#/lib/ProviderMeta';
import { ModelRoleIcon, type ModelRoleIconId } from './ModelRoleIcon';
import { ModelHoverCardBody, ModelPickerPopover, ROLE_NONE, splitModelSpec } from './model-picker';
import { roleFallbackLabelKey } from './role-fallback';

type RoleKey = Exclude<ModelRole, 'chat'>;
type RouteKey = keyof ProfileView['routes'];

const ROLE_DEFS: {
  role: RoleKey;
  labelKey: WebMessageIdWithoutParams;
  match: (c?: ModelModalities) => boolean;
  icon: ModelRoleIconId;
}[] = [
  {
    role: 'memory',
    labelKey: 'web.model.roleMemory',
    match: (c) => !!c?.input?.includes('text') && !!c?.output?.includes('text'),
    icon: 'memory'
  },
  {
    role: 'embedding',
    labelKey: 'web.model.roleEmbedding',
    match: (c) => c?.kind === 'embedding' || !!c?.output?.some((v) => v === 'embedding' || v === 'embeddings'),
    icon: 'embedding'
  },
  { role: 'vision', labelKey: 'web.model.roleVision', match: (c) => !!c?.input?.includes('image'), icon: 'vision' },
  {
    role: 'image',
    labelKey: 'web.model.roleImage',
    match: (c) => c?.kind === 'image' || !!c?.output?.includes('image'),
    icon: 'image'
  },
  {
    role: 'video',
    labelKey: 'web.model.roleVideo',
    match: (c) => c?.kind === 'video' || !!c?.output?.includes('video'),
    icon: 'video'
  },
  {
    role: 'speech',
    labelKey: 'web.model.roleSpeech',
    match: (c) => c?.kind === 'speech' || !!c?.output?.includes('speech'),
    icon: 'speech'
  },
  {
    role: 'transcription',
    labelKey: 'web.model.roleTranscription',
    match: (c) => c?.kind === 'transcription' || !!c?.output?.includes('transcription'),
    icon: 'transcription'
  }
];

const HIDE_EFFORT_ROLES = new Set<RouteKey>(['video', 'speech', 'transcription', 'embedding']);

function formatEffortLabel(effort: string | undefined): string {
  if (!effort) return '';
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

export function ProfileCard({
  defaultAlias,
  deleteDisabledReason,
  isDraft = false,
  modelsByProvider,
  onDelete,
  onDraftCreate,
  onRouteParamsChange,
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
  onRouteParamsChange: (role: RouteKey, params: GenerationParamsView) => void;
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
  const [openEffortPicker, setOpenEffortPicker] = useState<string | null>(null);
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
  const reasoningSummary = (role: RouteKey, model: ModelInfo | undefined) => {
    const selected = profile.routeParams?.[role]?.reasoningEffort ?? profile.params?.reasoningEffort;
    return resolveReasoningEffort(
      model?.modalities?.reasoningEfforts,
      selected,
      model?.modalities?.defaultReasoningEffort
    );
  };
  const setRouteReasoningEffort = (role: RouteKey, effort: string) => {
    const base = profile.routeParams?.[role] ?? {};
    const next = { ...base, reasoningEffort: effort };
    onRouteParamsChange(role, next);
    setOpenEffortPicker(null);
  };

  const primaryRows = [
    {
      key: 'chat' as const,
      label: t('web.model.defaultModel'),
      icon: 'chat' as const,
      model: defaultModelEntry,
      provMeta: defaultProvMeta,
      spec: defaultSpec,
      modelId: profile.routes.chat.modelId,
      noneLabel: t('web.model.selectModel'),
      noneClassName: 'italic',
      modelFilter: (m: ModelInfo) => !m.modalities?.output || m.modalities.output.includes('text')
    },
    {
      key: 'fast' as const,
      label: t('web.model.fastModel'),
      icon: 'fast' as const,
      model: fastModelEntry,
      provMeta: fastProvMeta,
      spec: fastSpec || ROLE_NONE,
      modelId: profile.routes.fast?.modelId ?? '',
      noneLabel: t('web.model.useDefaultModel'),
      modelFilter: (m: ModelInfo) => !m.modalities?.output || m.modalities.output.includes('text'),
      help: t('web.model.fastModelHint')
    }
  ];

  const roleRows = ROLE_DEFS.map(({ role, labelKey, match, icon }) => {
    const route = profile.routes[role];
    const current = route ? `${route.provider}:${route.modelId}` : '';
    const parsed = current ? splitModelSpec(current) : null;
    const model = parsed ? (modelsByProvider[parsed.providerId] ?? []).find((m) => m.id === parsed.modelId) : undefined;
    const provMeta = parsed ? metaFor(providers.find((p) => p.id === parsed.providerId)?.type ?? '') : null;
    return {
      key: role,
      label: t(labelKey),
      icon,
      model,
      provMeta,
      spec: current || ROLE_NONE,
      modelId: parsed?.modelId ?? '',
      noneLabel: t(roleFallbackLabelKey(defaultModelCaps, match)),
      modelFilter: (m: ModelInfo) => match(m.modalities)
    };
  });
  const rows = [...primaryRows, ...roleRows];

  return (
    <Card className="group/profile-card flex flex-col overflow-hidden border-border/70 bg-card p-0">
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
              {profile.alias || (
                <span className="font-normal text-muted-foreground italic">{t('web.model.untitled')}</span>
              )}
            </span>
            {isDefault && (
              <span className="shrink-0 rounded bg-primary/12 px-1.5 py-0.5 font-medium text-[10px] text-primary">
                {t('web.model.default')}
              </span>
            )}
          </button>
        )}
        <ProfileCardHoverActions>
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
                    <HugeiconsIcon icon={Delete02Icon} />
                  </Button>
                </span>
              </TooltipTrigger>
              {deleteDisabledReason && <TooltipContent>{deleteDisabledReason}</TooltipContent>}
            </Tooltip>
          )}
        </ProfileCardHoverActions>
      </div>

      <div className="flex flex-1 flex-col gap-1.5 p-2">
        {rows.map((row) => {
          const ProviderLogo = row.provMeta?.logo;
          const modelLabel = row.modelId ? (row.model?.label ?? row.modelId) : row.noneLabel;
          const showEffort = row.modelId && !HIDE_EFFORT_ROLES.has(row.key);
          const { efforts, value } = showEffort
            ? reasoningSummary(row.key, row.model)
            : { efforts: [], value: undefined };
          const configured = !!row.modelId;
          return (
            <div
              className={cn(
                'flex min-w-0 items-start gap-2 rounded-md border px-2.5 py-2 transition-colors',
                configured
                  ? 'border-border/60 bg-background/60 hover:border-border'
                  : 'border-border/70 border-dashed bg-muted/15 hover:bg-muted/25'
              )}
              data-role-row={row.key}
              key={row.key}
            >
              <span
                className={cn(
                  'mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-lg',
                  configured ? 'bg-primary/8 text-primary' : 'bg-muted/50 text-muted-foreground'
                )}
              >
                <ModelRoleIcon
                  className="size-6"
                  role={row.icon}
                />
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className="truncate">{row.label}</span>
                  {'help' in row && row.help && (
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
                        {row.help}
                      </HoverCardContent>
                    </HoverCard>
                  )}
                </div>

                <div className="mt-1 flex min-h-6 min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <HoverCard
                    onOpenChange={(open) => handleModelHoverOpenChange(row.key, open)}
                    open={openModelPicker === null && openModelHover === row.key}
                    openDelay={250}
                  >
                    <ModelPickerPopover
                      modelFilter={row.modelFilter}
                      modelsByProvider={modelsByProvider}
                      noneLabel={row.key === 'chat' ? undefined : row.noneLabel}
                      onOpenChange={(open) => handleModelPickerOpenChange(row.key, open)}
                      onValueChange={(spec) =>
                        onRouteChange(row.key, row.key !== 'chat' && spec === ROLE_NONE ? '' : spec)
                      }
                      providers={providers}
                      value={row.spec}
                    >
                      <HoverCardTrigger asChild>
                        <button
                          className="flex min-w-0 flex-1 basis-44 items-center gap-1.5 text-left text-xs transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          type="button"
                        >
                          {ProviderLogo && row.modelId && (
                            <ProviderLogo className={cn('size-3 shrink-0', row.provMeta?.color)} />
                          )}
                          <span
                            className={cn(
                              'min-w-0 truncate',
                              row.modelId ? 'font-medium' : 'text-muted-foreground',
                              'noneClassName' in row && row.noneClassName
                            )}
                          >
                            {modelLabel}
                          </span>
                        </button>
                      </HoverCardTrigger>
                    </ModelPickerPopover>
                    {row.modelId && (
                      <HoverCardContent
                        className="w-72"
                        side="top"
                      >
                        <ModelHoverCardBody model={row.model} />
                      </HoverCardContent>
                    )}
                  </HoverCard>

                  <div className="flex h-6 min-w-[4.75rem] shrink-0 items-center justify-end">
                    {!row.modelId && !HIDE_EFFORT_ROLES.has(row.key) ? (
                      <span className="inline-flex rounded-full bg-background px-2 py-0.5 text-[11px] text-muted-foreground ring-1 ring-border/70">
                        {t('web.model.inheritedDefault')}
                      </span>
                    ) : efforts.length > 0 ? (
                      <Popover
                        onOpenChange={(open) => setOpenEffortPicker(open ? row.key : null)}
                        open={openEffortPicker === row.key}
                      >
                        <PopoverTrigger asChild>
                          <button
                            className="inline-flex h-6 items-center gap-1 rounded-(--radius-sm) px-1.5 text-[11px] transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            type="button"
                          >
                            <span className="text-muted-foreground">{t('web.reasoning.effort')}</span>
                            {value ? (
                              <span className="font-medium text-primary">{formatEffortLabel(value)}</span>
                            ) : null}
                          </button>
                        </PopoverTrigger>
                        <PopoverContent
                          align="end"
                          className="w-72 p-0"
                        >
                          <ReasoningEffortControl
                            className="border-0 shadow-none"
                            compact
                            defaultLabel={t('web.reasoning.effort')}
                            onChange={(level) => {
                              if (level) setRouteReasoningEffort(row.key, level);
                            }}
                            options={efforts.map(reasoningEffortOption)}
                            value={value}
                          />
                        </PopoverContent>
                      </Popover>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
