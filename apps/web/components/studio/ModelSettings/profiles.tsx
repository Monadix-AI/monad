'use client';

import type { WebMessageIdWithoutParams } from '@monad/i18n';
import type {
  GenerationParamsView,
  ModelInfo,
  ModelModalities,
  ModelRole,
  ModelRoles,
  ProfileView,
  ProviderView
} from '@monad/protocol';

import { Button, Card, cn, Input } from '@monad/ui';
import { Database, Eye, Mic, Star, Trash2, Video, Wand2, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { useProviderMeta } from '@/lib/ProviderMeta';
import { ModelHoverCardBody, ModelPickerPopover, ROLE_NONE, splitModelSpec } from './model-picker';

type RoleKey = Exclude<ModelRole, 'chat'>;

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
  { role: 'embedding', labelKey: 'web.model.roleEmbedding', match: (c) => c?.kind === 'embedding', icon: Database }
];

const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;

export function ProfileCard({
  canDelete,
  defaultAlias,
  isDraft = false,
  modelsByProvider,
  onDelete,
  onDraftCreate,
  onFastModelChange,
  onModelChange,
  onParamsChange,
  onRolesChange,
  onSetDefault,
  onRename,
  profile,
  providers
}: {
  canDelete: boolean;
  defaultAlias: string;
  isDraft?: boolean;
  modelsByProvider: Record<string, ModelInfo[]>;
  onDelete: () => void;
  onDraftCreate?: () => void;
  onFastModelChange: (spec: string) => void;
  onModelChange: (spec: string) => void;
  onParamsChange: (params: GenerationParamsView) => void;
  onRolesChange: (roles: ModelRoles) => void;
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
    profile.provider && profile.modelId
      ? (modelsByProvider[profile.provider] ?? []).find((m) => m.id === profile.modelId)
      : undefined;
  const defaultModelCaps = defaultModelEntry?.modalities;
  const defaultSpec = profile.provider && profile.modelId ? `${profile.provider}:${profile.modelId}` : '';

  const fastModelEntry =
    profile.fastProvider && profile.fastModelId
      ? (modelsByProvider[profile.fastProvider] ?? []).find((m) => m.id === profile.fastModelId)
      : undefined;
  const fastSpec = profile.fastProvider && profile.fastModelId ? `${profile.fastProvider}:${profile.fastModelId}` : '';

  const defaultProvMeta = profile.provider
    ? metaFor(providers.find((p) => p.id === profile.provider)?.type ?? '')
    : null;
  const fastProvMeta = profile.fastProvider
    ? metaFor(providers.find((p) => p.id === profile.fastProvider)?.type ?? '')
    : null;

  const canCreate = isDraft && !!profile.alias.trim() && !!profile.provider && !!profile.modelId;

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
          {canDelete && (
            <Button
              aria-label={t('web.model.deleteProfile')}
              className="size-7 text-muted-foreground hover:text-destructive"
              onClick={onDelete}
              size="icon"
              variant="ghost"
            >
              <Trash2 />
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-1 flex-col">
        <div className="flex items-center justify-between gap-2 border-border/30 border-b px-3 py-1.5">
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
            <Star className="size-3" />
            {t('web.model.defaultModel')}
          </span>
          <HoverCard openDelay={250}>
            <ModelPickerPopover
              modelFilter={(m) => !m.modalities?.output || m.modalities.output.includes('text')}
              modelsByProvider={modelsByProvider}
              onValueChange={onModelChange}
              providers={providers}
              value={defaultSpec}
            >
              <HoverCardTrigger asChild>
                <button
                  className="flex max-w-[55%] items-center gap-1 truncate text-right text-xs hover:underline"
                  type="button"
                >
                  {defaultProvMeta?.logo && profile.modelId && (
                    <defaultProvMeta.logo className={cn('size-3 shrink-0', defaultProvMeta.color)} />
                  )}
                  {profile.modelId ? (
                    <span className="truncate font-medium">{defaultModelEntry?.label ?? profile.modelId}</span>
                  ) : (
                    <span className="text-muted-foreground italic">{t('web.model.selectModel')}</span>
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

        <div className="flex items-center justify-between gap-2 border-border/30 border-b px-3 py-1.5">
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
            <Zap className="size-3" />
            {t('web.model.fastModel')}
            <HoverCard openDelay={200}>
              <HoverCardTrigger asChild>
                <button
                  className="inline-flex size-3.5 items-center justify-center rounded-full border border-muted-foreground/40 text-[9px] text-muted-foreground hover:border-muted-foreground/70 hover:text-foreground"
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
          <HoverCard openDelay={250}>
            <ModelPickerPopover
              modelFilter={(m) => !m.modalities?.output || m.modalities.output.includes('text')}
              modelsByProvider={modelsByProvider}
              noneLabel={t('web.model.useDefaultModel')}
              onValueChange={(spec) => onFastModelChange(spec === ROLE_NONE ? '' : spec)}
              providers={providers}
              value={fastSpec || ROLE_NONE}
            >
              <HoverCardTrigger asChild>
                <button
                  className="flex max-w-[55%] items-center gap-1 truncate text-right text-xs hover:underline"
                  type="button"
                >
                  {fastProvMeta?.logo && profile.fastModelId && (
                    <fastProvMeta.logo className={cn('size-3 shrink-0', fastProvMeta.color)} />
                  )}
                  {profile.fastModelId ? (
                    <span className="truncate font-medium">{fastModelEntry?.label ?? profile.fastModelId}</span>
                  ) : (
                    <span className="text-muted-foreground">{t('web.model.useDefaultModel')}</span>
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

        {defaultModelCaps?.reasoning && (
          <div className="flex items-center justify-between gap-2 border-border/30 border-b px-3 py-1.5">
            <span className="shrink-0 text-[11px] text-muted-foreground">{t('web.model.reasoningEffort')}</span>
            <div className="flex gap-1">
              {REASONING_EFFORTS.map((level) => {
                const active = (profile.params?.reasoningEffort ?? 'medium') === level;
                return (
                  <button
                    className={cn(
                      'rounded-(--radius-sm) border px-2 py-0.5 text-xs transition-colors',
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

        {ROLE_DEFS.map(({ role, labelKey, match, icon: RoleIcon }) => {
          const current = profile.roles?.[role as RoleKey] ?? '';
          const isSet = !!current;
          const defaultCovers = defaultModelCaps !== undefined ? match(defaultModelCaps) : true;
          const notAvailable = !isSet && defaultModelCaps !== undefined && !defaultCovers;
          const parsed = isSet ? splitModelSpec(current) : null;
          const roleModel = parsed
            ? (modelsByProvider[parsed.providerId] ?? []).find((m) => m.id === parsed.modelId)
            : undefined;
          const roleProvMeta = parsed ? metaFor(providers.find((p) => p.id === parsed.providerId)?.type ?? '') : null;
          return (
            <div
              className="flex items-center justify-between gap-2 border-border/30 border-b px-3 py-1.5 last:border-b-0"
              key={role}
            >
              <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                <RoleIcon className="size-3" />
                {t(labelKey)}
              </span>
              <HoverCard openDelay={250}>
                <ModelPickerPopover
                  modelFilter={(m) => match(m.modalities)}
                  modelsByProvider={modelsByProvider}
                  noneLabel={t('web.model.useDefaultModel')}
                  onValueChange={(spec) =>
                    onRolesChange({
                      ...(profile.roles ?? {}),
                      [role]: spec === ROLE_NONE ? undefined : spec
                    } as ModelRoles)
                  }
                  providers={providers}
                  value={current || ROLE_NONE}
                >
                  <HoverCardTrigger asChild>
                    <button
                      className="flex max-w-[55%] items-center gap-1 truncate text-right text-xs hover:underline"
                      type="button"
                    >
                      {isSet && roleProvMeta?.logo && (
                        <roleProvMeta.logo className={cn('size-3 shrink-0', roleProvMeta.color)} />
                      )}
                      {isSet ? (
                        <span className="truncate font-medium">{roleModel?.label ?? parsed?.modelId ?? current}</span>
                      ) : (
                        <span className="text-muted-foreground">
                          {notAvailable ? t('web.model.roleNotAvailable') : t('web.model.useDefaultModel')}
                        </span>
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
    </Card>
  );
}
