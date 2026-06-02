'use client';

import type { GenerationParamsView, ModelInfo, ModelRoles, ProfileView } from '@monad/protocol';

import { ModelProviderType } from '@monad/protocol';
import { Button, ScrollArea } from '@monad/ui';
import { Plus, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { useModelSettings, useModelSettingsQueryState, useProviderDetail } from '@/hooks/use-model-settings';
import { useProviderMeta } from '@/lib/ProviderMeta';
import { StudioPanel, StudioPanelHeader } from '../StudioPanel';
import { splitModelSpec } from './model-picker';
import { ProfileCard } from './profiles';
import { ProviderCard, ProviderDialog } from './providers';
import { ModelEmptyState, ModelSection, ModelSettingsSkeleton } from './shared';

function emptyProfile(): ProfileView {
  return { alias: '', provider: '', modelId: '', params: {}, fallbacks: [], roles: {} };
}

function ProviderModelsCollector({
  onModels,
  providerId
}: {
  onModels: (id: string, models: ModelInfo[]) => void;
  providerId: string;
}) {
  const { models } = useProviderDetail(providerId);
  useEffect(() => {
    if (models.length) onModels(providerId, models);
  }, [providerId, models, onModels]);
  return null;
}

export function ModelSettings(_props: { onClose: () => void }) {
  const t = useT();
  const settings = useModelSettings();
  const settingsQuery = useModelSettingsQueryState();
  const { providers, profiles, defaultAlias } = settings;

  const { metaFor, catalog } = useProviderMeta();
  const PROVIDER_TYPES = catalog.map((e) => ({
    value: e.type as ModelProviderType,
    label: e.label,
    needsUrl: e.needsUrl ?? false
  }));

  const [providerDialogTarget, setProviderDialogTarget] = useState<null | 'add' | string>(null);

  const [draftProfile, setDraftProfile] = useState<ProfileView | null>(null);
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, ModelInfo[]>>({});

  const onProviderModels = useCallback((id: string, models: ModelInfo[]) => {
    setModelsByProvider((prev) => (prev[id] === models ? prev : { ...prev, [id]: models }));
  }, []);

  const handleDeleteProvider = async (id: string) => {
    try {
      await settings.deleteProvider(id);
      if (providerDialogTarget === id) setProviderDialogTarget(null);
    } catch {
      //
    }
  };

  const handleDeleteProfile = async (alias: string) => {
    try {
      await settings.deleteProfile(alias);
    } catch {
      //
    }
  };

  const handleSetDefaultProfile = async (alias: string) => {
    try {
      await settings.setDefaultProfile(alias);
    } catch {
      //
    }
  };

  const updateProfileRoles = async (profile: ProfileView, roles: ModelRoles) => {
    try {
      await settings.setProfile({ ...profile, roles });
    } catch {
      //
    }
  };

  const updateProfileParams = async (profile: ProfileView, params: GenerationParamsView) => {
    try {
      await settings.setProfile({ ...profile, params });
    } catch {
      //
    }
  };

  const updateProfileModel = async (profile: ProfileView, provider: string, modelId: string) => {
    try {
      await settings.setProfile({ ...profile, modelId, provider });
    } catch {
      //
    }
  };

  const renameProfile = async (profile: ProfileView, newAlias: string) => {
    try {
      await settings.deleteProfile(profile.alias);
      await settings.setProfile({ ...profile, alias: newAlias });
    } catch {
      //
    }
  };

  const editingProvider =
    providerDialogTarget && providerDialogTarget !== 'add'
      ? providers.find((p) => p.id === providerDialogTarget)
      : undefined;

  return (
    <StudioPanel className="overflow-hidden">
      <StudioPanelHeader
        actions={
          <Button
            aria-label={t('web.common.refresh')}
            className="size-7"
            onClick={() => settingsQuery.refetch()}
            size="icon"
            variant="ghost"
          >
            <RefreshCw className={settingsQuery.isLoading ? 'animate-spin' : ''} />
          </Button>
        }
        subtitle={t('web.model.subtitle')}
        title={t('web.model.title')}
      />

      <ScrollArea className="flex-1">
        {settingsQuery.isLoading ? (
          <ModelSettingsSkeleton />
        ) : (
          <div className="mx-auto flex max-w-5xl flex-col gap-5 p-5">
            {providers.map((p) => (
              <ProviderModelsCollector
                key={p.id}
                onModels={onProviderModels}
                providerId={p.id}
              />
            ))}

            <ModelSection title={t('web.model.providers')}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="max-w-2xl text-muted-foreground text-sm">{t('web.model.providersDesc')}</p>
                <Button
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => setProviderDialogTarget('add')}
                  size="sm"
                  variant="ghost"
                >
                  <Plus /> {t('web.model.providerBtn')}
                </Button>
              </div>

              {providers.length === 0 && <ModelEmptyState>{t('web.model.noProviders')}</ModelEmptyState>}

              <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,24rem),1fr))] items-start gap-3">
                {providers.map((p) => (
                  <ProviderCard
                    key={p.id}
                    onEdit={() => setProviderDialogTarget(p.id)}
                    provider={p}
                  />
                ))}
              </div>
            </ModelSection>

            <ModelSection title={t('web.model.profiles')}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="max-w-2xl text-muted-foreground text-sm">{t('web.model.profilesDesc')}</p>
                <Button
                  onClick={() => setDraftProfile(emptyProfile())}
                  size="sm"
                  variant="ghost"
                >
                  <Plus /> {t('web.model.profileBtn')}
                </Button>
              </div>

              {profiles.length === 0 && !draftProfile && <ModelEmptyState>{t('web.model.noProfiles')}</ModelEmptyState>}

              <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,22rem),1fr))] items-stretch gap-3">
                {draftProfile && (
                  <ProfileCard
                    canDelete={false}
                    defaultAlias={defaultAlias}
                    isDraft
                    key="__draft__"
                    modelsByProvider={modelsByProvider}
                    onDelete={() => setDraftProfile(null)}
                    onDraftCreate={async () => {
                      if (!draftProfile.alias || !draftProfile.provider || !draftProfile.modelId) return;
                      try {
                        await settings.setProfile(draftProfile);
                        setDraftProfile(null);
                      } catch {
                        /* ignore */
                      }
                    }}
                    onFastModelChange={(spec) => {
                      if (!spec) {
                        setDraftProfile((d) => (d ? { ...d, fastProvider: undefined, fastModelId: undefined } : d));
                        return;
                      }
                      const parsed = splitModelSpec(spec);
                      if (!parsed) return;
                      setDraftProfile((d) =>
                        d ? { ...d, fastProvider: parsed.providerId, fastModelId: parsed.modelId } : d
                      );
                    }}
                    onModelChange={(spec) => {
                      const parsed = splitModelSpec(spec);
                      if (!parsed) return;
                      setDraftProfile((d) => (d ? { ...d, provider: parsed.providerId, modelId: parsed.modelId } : d));
                    }}
                    onParamsChange={(params) => setDraftProfile((d) => (d ? { ...d, params } : d))}
                    onRename={(alias) => setDraftProfile((d) => (d ? { ...d, alias } : d))}
                    onRolesChange={(roles) => setDraftProfile((d) => (d ? { ...d, roles } : d))}
                    onSetDefault={() => {}}
                    profile={draftProfile}
                    providers={providers}
                  />
                )}
                {profiles.map((p) => (
                  <ProfileCard
                    canDelete={p.alias !== 'default' && profiles.length > 1}
                    defaultAlias={defaultAlias}
                    key={p.alias}
                    modelsByProvider={modelsByProvider}
                    onDelete={() => void handleDeleteProfile(p.alias)}
                    onFastModelChange={(spec) => {
                      if (!spec) {
                        void settings.setProfile({ ...p, fastProvider: undefined, fastModelId: undefined });
                        return;
                      }
                      const parsed = splitModelSpec(spec);
                      if (!parsed) return;
                      void settings.setProfile({ ...p, fastProvider: parsed.providerId, fastModelId: parsed.modelId });
                    }}
                    onModelChange={(spec) => {
                      const parsed = splitModelSpec(spec);
                      if (!parsed) return;
                      void updateProfileModel(p, parsed.providerId, parsed.modelId);
                    }}
                    onParamsChange={(params) => void updateProfileParams(p, params)}
                    onRename={(newAlias) => void renameProfile(p, newAlias)}
                    onRolesChange={(roles) => void updateProfileRoles(p, roles)}
                    onSetDefault={() => void handleSetDefaultProfile(p.alias)}
                    profile={p}
                    providers={providers}
                  />
                ))}
              </div>
            </ModelSection>
          </div>
        )}
      </ScrollArea>

      <ProviderDialog
        metaFor={metaFor}
        mode={providerDialogTarget === 'add' ? 'add' : 'edit'}
        onClose={() => setProviderDialogTarget(null)}
        onDelete={editingProvider ? () => void handleDeleteProvider(editingProvider.id) : undefined}
        open={providerDialogTarget !== null}
        PROVIDER_TYPES={PROVIDER_TYPES}
        provider={editingProvider}
        providers={providers}
        settings={settings}
      />
    </StudioPanel>
  );
}
