'use client';

import type { GenerationParamsView, ModelInfo, ProfileView } from '@monad/protocol';

import { useListAgentsQuery } from '@monad/client-rtk';
import { ModelProviderType } from '@monad/protocol';
import { Button, ScrollArea } from '@monad/ui';
import { Plus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { flushSync } from 'react-dom';

import { useT } from '@/components/I18nProvider';
import { PanelShell, PanelShellHeader } from '@/components/ui/panel-shell';
import { useModelSettings, useModelSettingsQueryState, useProviderDetail } from '@/hooks/use-model-settings';
import { useProviderMeta } from '@/lib/ProviderMeta';
import { type DeleteBlock, profileDeleteBlock, providerDeleteBlock } from './delete-guards';
import { splitModelSpec } from './model-picker';
import { type ProfileKeyMap, profileDisplayKey, profileKeysForRename } from './profile-rename';
import { ProfileCard } from './profiles';
import { ProviderCard, ProviderDialog } from './providers';
import { ModelEmptyState, ModelSection, ModelSettingsSkeleton } from './shared';

function emptyProfile(): ProfileView {
  return { alias: '', routes: { chat: { provider: '', modelId: '' } }, params: {}, fallbacks: [] };
}

type RouteKey = keyof ProfileView['routes'];

function profileWithRoute(profile: ProfileView, role: RouteKey, spec: string): ProfileView {
  const routes = { ...profile.routes };
  if (!spec) {
    if (role !== 'chat') routes[role] = undefined;
    return { ...profile, routes };
  }
  const parsed = splitModelSpec(spec);
  if (!parsed) return profile;
  routes[role] = { provider: parsed.providerId, modelId: parsed.modelId };
  return { ...profile, routes };
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
  const agentsQuery = useListAgentsQuery();
  const { providers, profiles, defaultAlias } = settings;
  const agents = agentsQuery.data?.agents ?? [];

  const { metaFor, catalog } = useProviderMeta();
  const PROVIDER_TYPES = catalog.map((e) => ({
    value: e.type as ModelProviderType,
    label: e.label,
    needsUrl: e.needsUrl ?? false
  }));

  const [providerDialogTarget, setProviderDialogTarget] = useState<null | 'add' | string>(null);

  const [draftProfile, setDraftProfile] = useState<ProfileView | null>(null);
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, ModelInfo[]>>({});
  const [profileKeyMap, setProfileKeyMap] = useState<ProfileKeyMap>({});

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

  const updateProfileRoute = async (profile: ProfileView, role: RouteKey, spec: string) => {
    try {
      await settings.setProfile(profileWithRoute(profile, role, spec));
    } catch {
      //
    }
  };

  const updateProfileRouteParams = async (profile: ProfileView, role: RouteKey, params: GenerationParamsView) => {
    try {
      await settings.setProfile({ ...profile, routeParams: { ...profile.routeParams, [role]: params } });
    } catch {
      //
    }
  };

  const renameProfile = async (profile: ProfileView, newAlias: string) => {
    const trimmed = newAlias.trim();
    if (!trimmed || trimmed === profile.alias) return;
    flushSync(() => {
      setProfileKeyMap((keys) => profileKeysForRename(keys, profile.alias, trimmed));
    });
    try {
      await settings.renameProfile(profile.alias, trimmed);
    } catch {
      setProfileKeyMap((keys) => {
        const next = { ...keys };
        delete next[trimmed];
        return next;
      });
    }
  };

  const editingProvider =
    providerDialogTarget && providerDialogTarget !== 'add'
      ? providers.find((p) => p.id === providerDialogTarget)
      : undefined;
  const deleteReason = (block: DeleteBlock | null): string | undefined => {
    if (!block) return undefined;
    switch (block.kind) {
      case 'default-profile':
        return t('web.model.deleteProfileDefaultBlocked');
      case 'single-profile':
        return t('web.model.deleteProfileSingleBlocked');
      case 'agent':
        return t('web.model.deleteProfileAgentBlocked', { name: block.name });
      case 'profile':
        return t('web.model.deleteProviderProfileBlocked', { alias: block.alias });
    }
  };

  return (
    <PanelShell className="overflow-hidden">
      <PanelShellHeader
        subtitle={t('web.model.subtitle')}
        title={t('web.model.title')}
      />

      <ScrollArea className="min-h-0 flex-1">
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
                    deleteDisabledReason={deleteReason(providerDeleteBlock(p, profiles))}
                    key={p.id}
                    onDelete={() => void handleDeleteProvider(p.id)}
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

              <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,28rem),1fr))] items-stretch gap-3">
                {draftProfile && (
                  <ProfileCard
                    defaultAlias={defaultAlias}
                    isDraft
                    key="__draft__"
                    modelsByProvider={modelsByProvider}
                    onDelete={() => setDraftProfile(null)}
                    onDraftCreate={async () => {
                      if (
                        !draftProfile.alias ||
                        !draftProfile.routes.chat.provider ||
                        !draftProfile.routes.chat.modelId
                      )
                        return;
                      try {
                        await settings.setProfile(draftProfile);
                        setDraftProfile(null);
                      } catch {
                        /* ignore */
                      }
                    }}
                    onRename={(alias) => setDraftProfile((d) => (d ? { ...d, alias } : d))}
                    onRouteChange={(role, spec) => setDraftProfile((d) => (d ? profileWithRoute(d, role, spec) : d))}
                    onRouteParamsChange={(role, params) =>
                      setDraftProfile((d) => (d ? { ...d, routeParams: { ...d.routeParams, [role]: params } } : d))
                    }
                    onSetDefault={() => {}}
                    profile={draftProfile}
                    providers={providers}
                  />
                )}
                {profiles.map((p) => (
                  <ProfileCard
                    defaultAlias={defaultAlias}
                    deleteDisabledReason={deleteReason(profileDeleteBlock(p, profiles, agents, defaultAlias))}
                    key={profileDisplayKey(p.alias, profileKeyMap)}
                    modelsByProvider={modelsByProvider}
                    onDelete={() => void handleDeleteProfile(p.alias)}
                    onRename={(newAlias) => void renameProfile(p, newAlias)}
                    onRouteChange={(role, spec) => void updateProfileRoute(p, role, spec)}
                    onRouteParamsChange={(role, params) => void updateProfileRouteParams(p, role, params)}
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
        open={providerDialogTarget !== null}
        PROVIDER_TYPES={PROVIDER_TYPES}
        provider={editingProvider}
        providers={providers}
        settings={settings}
      />
    </PanelShell>
  );
}
