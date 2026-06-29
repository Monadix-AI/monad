'use client';

import type { AgentId, ModelInfo, ProviderView } from '@monad/protocol';

import {
  profileSelectors,
  providerAdapter,
  providerSelectors,
  useAddCredentialMutation,
  useCreateAgentMutation,
  useGetDefaultAgentQuery,
  useListAgentsQuery,
  useListProfilesQuery,
  useListProvidersQuery,
  useSetDefaultAgentMutation,
  useSetDefaultMutation,
  useSetInitHomeMutation,
  useSetProfileMutation,
  useSetProviderMutation,
  useTestConnectionMutation
} from '@monad/client-rtk';
import { KNOWN_PROVIDER_TYPES, ModelProviderType } from '@monad/protocol';
import { Button, cn, Input, Label } from '@monad/ui';
import { Check, Lock, Plus, Sparkles, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { InitBackground } from '@/components/InitBackground';
import { InitLogoCanvas } from '@/components/InitLogoCanvas';
import { useMonadRuntime } from '@/lib/monad-runtime-provider';
import { useProviderMeta } from '@/lib/ProviderMeta';
import { SECRET_INPUT_PASSWORD_MANAGER_PROPS } from './studio/ModelSettings/secret-input-props';

interface DraftKey {
  id: string;
  accessToken: string;
  /** Key already persisted in the DB — no accessToken available, skip re-saving. */
  saved?: boolean;
}

interface DraftProvider {
  type: string;
  id: string;
  baseUrl?: string;
  extra?: Record<string, string>;
  keys: DraftKey[];
  models: ModelInfo[];
}

function dedupeModels(ms: ModelInfo[]): ModelInfo[] {
  const seen = new Set<string>();
  return ms.filter((m) => !seen.has(m.id) && !!seen.add(m.id));
}

type Step = 'home' | 'provider' | 'model' | 'agent';
type ProviderSubStep = 'list' | 'pick-type' | 'add-key';

export function InitWizard({ homePath }: { homePath?: string }) {
  const t = useT();
  const { client: monadClient } = useMonadRuntime();
  const [step, setStep] = useState<Step>('home');
  const [customHome, setCustomHome] = useState('');
  const [homeError, setHomeError] = useState('');
  const [restarting, setRestarting] = useState(false);

  const [providers, setProviders] = useState<DraftProvider[]>([]);
  const [subStep, setSubStep] = useState<ProviderSubStep>('list');
  const [addingType, setAddingType] = useState<string>(ModelProviderType.Anthropic);
  const [addingToProviderId, setAddingToProviderId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [done, setDone] = useState(false);

  const [addBaseUrl, setAddBaseUrl] = useState('');
  const [addApiKey, setAddApiKey] = useState('');
  const [addExtra, setAddExtra] = useState<Record<string, string>>({});
  const [addTested, setAddTested] = useState(false);
  const [addTestError, setAddTestError] = useState('');
  const [addModels, setAddModels] = useState<ModelInfo[]>([]);

  const [selectedProviderId, setSelectedProviderId] = useState('');
  const [selectedModelId, setSelectedModelId] = useState('');
  const [savedModelAlias, setSavedModelAlias] = useState('');

  const [modelFilter, setModelFilter] = useState('');

  const [agentName, setAgentName] = useState('My Agent');
  const [agentCapabilities, setAgentCapabilities] = useState('');
  const [agentSaving, setAgentSaving] = useState(false);
  const [agentError, setAgentError] = useState('');
  const [existingDefaultAgentId, setExistingDefaultAgentId] = useState<AgentId | null>(null);

  const { data: existingProviders } = useListProvidersQuery();
  const { data: existingProfiles } = useListProfilesQuery();
  const { data: existingAgentsData } = useListAgentsQuery();
  const existingAgents = existingAgentsData?.agents;
  const { data: loadedDefaultAgentData } = useGetDefaultAgentQuery();
  const loadedDefaultAgentId = loadedDefaultAgentData?.agentId;
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    if (seeded || !existingProviders || !existingProfiles || existingAgents === undefined) return;

    async function seed() {
      const drafts: DraftProvider[] = await Promise.all(
        providerSelectors.selectAll(existingProviders ?? providerAdapter.getInitialState()).map(async (p) => {
          const result = await monadClient.treaty.v1.settings.model.providers({ id: p.id }).credentials.get();
          const creds = result.data?.credentials ?? [];
          return {
            type: p.type,
            id: p.id,
            baseUrl: p.baseUrl,
            extra: p.extra,
            keys: creds.map((c: { id: string }) => ({ id: c.id, accessToken: '', saved: true as const })),
            models: []
          };
        })
      );
      if (drafts.length > 0) setProviders(drafts);

      const defaultProfile = existingProfiles
        ? profileSelectors.selectAll(existingProfiles.profiles).find((p) => p.alias === existingProfiles.defaultAlias)
        : undefined;
      if (defaultProfile) {
        setSelectedProviderId(defaultProfile.routes.chat.provider);
        setSelectedModelId(defaultProfile.routes.chat.modelId);
        setModelFilter(defaultProfile.routes.chat.modelId);
      }

      if (existingAgents && loadedDefaultAgentId) {
        const agent = existingAgents.find((a) => a.id === loadedDefaultAgentId);
        if (agent) {
          setAgentName(agent.name);
          setAgentCapabilities(agent.capabilities.join(', '));
          setExistingDefaultAgentId(agent.id);
        }
      }

      setSeeded(true);
    }

    void seed();
  }, [existingProviders, existingProfiles, existingAgents, loadedDefaultAgentId, monadClient, seeded]);

  const [setInitHome] = useSetInitHomeMutation();
  const [testConnection, { isLoading: isTesting }] = useTestConnectionMutation();
  const [setProvider] = useSetProviderMutation();
  const [addCredential] = useAddCredentialMutation();
  const [setProfile] = useSetProfileMutation();
  const [setDefault] = useSetDefaultMutation();
  const [createAgent] = useCreateAgentMutation();
  const [setDefaultAgent] = useSetDefaultAgentMutation();

  // Provider catalog (labels, base-url-needed, key hints, extra fields) assembled from registered providers' descriptors.
  const { metaFor, catalog } = useProviderMeta();
  const addingMeta = metaFor(addingType as ModelProviderType);
  // Provider types to offer in the picker: the daemon's catalog (so third-party `provider` atoms
  // appear too), falling back to the known built-ins while the catalog query is still loading.
  const providerTypes: string[] = catalog.length > 0 ? catalog.map((d) => d.type) : [...KNOWN_PROVIDER_TYPES];
  const addingExistingProvider = providers.find((p) => p.id === addingToProviderId) ?? null;
  // Only show base URL input when creating a new provider that requires it
  const showBaseUrlInput = (addingMeta.needsUrl ?? false) && addingExistingProvider === null;
  const extraFields = addingExistingProvider === null ? (addingMeta.extraFields ?? []) : [];

  // A credential is addable once the basic fields are filled — no model required.
  const keyOk = addApiKey.trim().length > 0 || (addingMeta.keyOptional ?? false);
  const urlOk = !showBaseUrlInput || addBaseUrl.trim().length > 0;
  const extraOk = extraFields.every((f) => !f.required || (addExtra[f.key]?.trim().length ?? 0) > 0);
  const canTest = keyOk && urlOk && extraOk;
  const canAdd = canTest;

  function resetAddKeyForm() {
    setAddBaseUrl('');
    setAddApiKey('');
    setAddExtra({});
    setAddTested(false);
    setAddTestError('');
    setAddModels([]);
  }

  function goPickType() {
    setAddingToProviderId(null);
    resetAddKeyForm();
    setSubStep('pick-type');
  }

  function pickProviderType(type: string) {
    setAddingType(type);
    setAddingToProviderId(null);
    resetAddKeyForm();
    setSubStep('add-key');
  }

  function goAddKeyToProvider(provider: DraftProvider) {
    setAddingType(provider.type);
    setAddingToProviderId(provider.id);
    resetAddKeyForm();
    setSubStep('add-key');
  }

  function removeKey(providerId: string, keyId: string) {
    setProviders((prev) => {
      const updated = prev.map((p) => (p.id === providerId ? { ...p, keys: p.keys.filter((k) => k.id !== keyId) } : p));
      return updated.filter((p) => p.keys.length > 0);
    });
  }

  async function handleSetHome() {
    setHomeError('');
    if (customHome) {
      setRestarting(true);
      const result = await setInitHome({ path: customHome });
      if ('error' in result) {
        setHomeError(t('web.init.homeError'));
        setRestarting(false);
        return;
      }
      for (let i = 0; i < 30; i++) {
        await new Promise<void>((r) => setTimeout(r, 1000));
        try {
          const res = await fetch('/api/health');
          if (res.ok) break;
        } catch {
          /* not yet */
        }
      }
      setRestarting(false);
    }
    setStep('provider');
  }

  async function handleTest() {
    setAddTestError('');
    setAddTested(false);
    const baseUrl = addingExistingProvider?.baseUrl ?? (showBaseUrlInput ? addBaseUrl : undefined);
    const extra = addingExistingProvider?.extra ?? (extraFields.length > 0 ? addExtra : undefined);
    const provider: ProviderView = {
      id: addingExistingProvider?.id ?? `${addingType}-test`,
      label: addingMeta.label ?? addingType,
      type: addingType as (typeof KNOWN_PROVIDER_TYPES)[number],
      ...(baseUrl ? { baseUrl } : {}),
      ...(extra ? { extra } : {})
    };
    const result = await testConnection({ provider, accessToken: addApiKey });
    if ('error' in result) {
      setAddTestError(t('web.init.connFailedKey'));
      return;
    }
    const data = result.data;
    if (!data.ok) {
      setAddTestError(data.error ?? t('web.init.connFailed'));
      return;
    }
    const availableModels = data.models ?? [];
    setAddModels(availableModels);
    setAddTested(true);
  }

  function handleAddKey() {
    const newKey: DraftKey = { id: crypto.randomUUID(), accessToken: addApiKey };
    const newExtra = extraFields.length > 0 ? addExtra : undefined;
    const discoveredModels = addModels;

    setProviders((prev) => {
      if (addingToProviderId) {
        return prev.map((p) =>
          p.id === addingToProviderId
            ? { ...p, keys: [...p.keys, newKey], models: dedupeModels([...p.models, ...discoveredModels]) }
            : p
        );
      }
      // Non-URL providers share one provider entry per type regardless of how many keys are added.
      const existing = !addingMeta.needsUrl ? prev.find((p) => p.type === addingType) : null;
      if (existing) {
        return prev.map((p) =>
          p.id === existing.id
            ? { ...p, keys: [...p.keys, newKey], models: dedupeModels([...p.models, ...discoveredModels]) }
            : p
        );
      }
      return [
        ...prev,
        {
          type: addingType,
          id: `${addingType}-${Date.now()}`,
          baseUrl: addBaseUrl || undefined,
          ...(newExtra ? { extra: newExtra } : {}),
          keys: [newKey],
          models: discoveredModels
        }
      ];
    });

    resetAddKeyForm();
    setSubStep('list');
  }

  function goToModelStep() {
    const first = providers[0];
    const firstModel = first?.models[0];
    setSelectedProviderId(first?.id ?? '');
    setSelectedModelId(firstModel?.id ?? '');
    setModelFilter(firstModel ? (firstModel.label ?? firstModel.id) : '');
    setStep('model');
  }

  async function handleSave() {
    setSaveError('');
    setSaving(true);
    const existingProviderIds = new Set(
      providerSelectors.selectAll(existingProviders ?? providerAdapter.getInitialState()).map((p) => p.id)
    );
    try {
      for (const p of providers) {
        const label = metaFor(p.type as ModelProviderType).label ?? p.type;
        const pv: ProviderView = {
          id: p.id,
          label,
          type: p.type as (typeof KNOWN_PROVIDER_TYPES)[number],
          ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
          ...(p.extra ? { extra: p.extra } : {})
        };
        // Skip setProvider for providers already in DB (PUT would be harmless but unnecessary).
        if (!existingProviderIds.has(p.id)) await setProvider(pv);
        for (const k of p.keys) {
          if (k.saved) continue; // already persisted — don't create a duplicate
          await addCredential({
            providerId: p.id,
            label: `${label} key`,
            authType: 'api_key',
            accessToken: k.accessToken,
            ...(p.baseUrl ? { baseUrl: p.baseUrl } : {})
          });
        }
      }

      const effectiveProviderId = selectedProviderId || providers[0]?.id || '';
      const effectiveModelId = selectedModelId || modelFilter.trim();
      let savedAlias = '';
      if (effectiveProviderId && effectiveModelId) {
        const alias = 'default';
        await setProfile({
          alias,
          routes: { chat: { provider: effectiveProviderId, modelId: effectiveModelId } },
          params: {},
          fallbacks: []
        });
        await setDefault({ alias });
        savedAlias = alias;
      }
      setSavedModelAlias(savedAlias);
      setStep('agent');
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : t('web.init.saveError'));
    } finally {
      setSaving(false);
    }
  }

  if (restarting) {
    return (
      <>
        <InitBackground />
        <div className="flex h-screen items-center justify-center p-4">
          <div className="app-frame flex animate-init-rise flex-col items-center gap-4 px-8 py-7">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-current border-t-transparent opacity-50" />
            <p className="text-muted-foreground text-sm">{t('web.init.restarting')}</p>
          </div>
        </div>
      </>
    );
  }

  if (done) {
    return (
      <>
        <InitBackground />
        <div className="flex h-screen items-center justify-center p-4">
          <div className="app-frame flex w-full max-w-md animate-init-rise flex-col items-center gap-5 px-8 py-12 text-center">
            <div className="relative flex h-16 w-16 items-center justify-center">
              <span className="absolute inset-0 animate-init-ring rounded-full bg-success/40" />
              <span className="absolute inset-0 animate-init-ring rounded-full bg-success/30 [animation-delay:0.3s]" />
              <span className="flex h-16 w-16 animate-init-pop items-center justify-center rounded-full bg-success text-primary-foreground shadow-lg">
                <Check className="h-8 w-8" />
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              <h1 className="poster-heading text-3xl text-foreground">{t('web.init.doneTitle')}</h1>
              <p className="text-muted-foreground text-sm">{t('web.init.doneDesc')}</p>
            </div>
            <Button
              className="transition-transform hover:-translate-y-0.5 active:translate-y-0"
              onClick={() => window.location.assign('/')}
            >
              <span className="flex items-center gap-1.5">
                <Sparkles className="h-4 w-4" />
                {t('web.init.enter')}
              </span>
            </Button>
          </div>
        </div>
      </>
    );
  }

  const title =
    step === 'home'
      ? t('web.init.titleHome')
      : step === 'model'
        ? t('web.init.titleModel')
        : step === 'agent'
          ? t('web.init.titleAgent')
          : subStep === 'pick-type'
            ? t('web.init.titlePickType')
            : subStep === 'add-key'
              ? t('web.init.titleAddKey', { provider: addingMeta?.label ?? addingType })
              : t('web.init.titleProviders');

  const description =
    step === 'home'
      ? t('web.init.descHome')
      : step === 'agent'
        ? t('web.init.descAgent')
        : step === 'model'
          ? t('web.init.descModel')
          : subStep === 'list'
            ? t('web.init.descList')
            : subStep === 'pick-type'
              ? t('web.init.descPickType')
              : addingExistingProvider
                ? t('web.init.descAddKeyExisting', { provider: addingMeta?.label ?? addingType })
                : t('web.init.descAddKey');

  const stepIndex = step === 'home' ? 0 : step === 'provider' ? 1 : step === 'model' ? 2 : 3;

  const renderWizardContent = () => (
    <>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2.5">
          <div className="flex items-center gap-1.5">
            {[0, 1, 2, 3].map((i) => {
              const isActive = i === stepIndex;
              const isDone = i < stepIndex;
              return (
                <span
                  className={cn(
                    'h-1.5 rounded-full transition-all duration-500 ease-out',
                    isActive
                      ? 'w-6 animate-init-pulse bg-foreground'
                      : isDone
                        ? 'w-4 bg-foreground/70'
                        : 'w-4 bg-muted-foreground/25'
                  )}
                  key={i}
                />
              );
            })}
          </div>
          <span className="flex items-center gap-1 text-muted-foreground text-xs">
            <Sparkles className="h-3 w-3 text-foreground/40" />
            {t('web.init.step', { n: stepIndex + 1 })}
          </span>
        </div>
        <h1 className="poster-heading text-[2rem] text-foreground">{title}</h1>
        <p className="text-muted-foreground text-sm">{description}</p>
      </div>

      {/* keyed so each transition replays a soft cross-fade */}
      <div
        className="animate-init-fade"
        key={`${step}:${subStep}`}
      >
        {step === 'home' && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="home-path">{t('web.init.homeLabel')}</Label>
              <p className="break-all font-mono text-muted-foreground text-xs">{homePath ?? '~/.monad'}</p>
              <Input
                id="home-path"
                onChange={(e) => setCustomHome(e.target.value)}
                placeholder={t('web.init.homePlaceholder')}
                value={customHome}
              />
              {homeError && <p className="text-destructive text-xs">{homeError}</p>}
              {customHome && <p className="text-muted-foreground text-xs">{t('web.init.homeRestartNote')}</p>}
            </div>
            <Button
              className="w-full hover:-translate-y-0.5 active:translate-y-0"
              onClick={handleSetHome}
            >
              {t('web.init.continue')}
            </Button>
          </div>
        )}

        {step === 'provider' && subStep === 'list' && (
          <div className="flex flex-col gap-4">
            {providers.length === 0 ? (
              <div className="panel-subtle border-dashed py-8 text-center">
                <p className="text-muted-foreground text-sm">{t('web.init.noProviders')}</p>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {providers.map((p) => {
                  const pm = metaFor(p.type as ModelProviderType);
                  const Logo = pm?.logo;
                  return (
                    <div
                      className="panel-subtle px-4 py-3"
                      key={p.id}
                    >
                      <div className="mb-2 flex items-center gap-2">
                        {Logo && <Logo className={cn('h-4 w-4 shrink-0', pm?.color)} />}
                        <span className="font-medium text-sm">{pm?.label ?? p.type}</span>
                        {p.baseUrl && (
                          <span className="truncate font-mono text-muted-foreground text-xs">{p.baseUrl}</span>
                        )}
                      </div>
                      <div className="flex flex-col gap-1.5">
                        {p.keys.map((k) => (
                          <div
                            className="flex items-center justify-between gap-2"
                            key={k.id}
                          >
                            <span className="font-mono text-muted-foreground text-xs">
                              {'••••••••'}
                              {k.saved ? '····' : k.accessToken.slice(-4)}
                            </span>
                            {k.saved ? (
                              <Lock
                                aria-label={t('web.init.savedKey')}
                                className="h-3 w-3 text-muted-foreground/40"
                              />
                            ) : (
                              <button
                                aria-label={t('web.init.removeKey')}
                                className="text-muted-foreground/50 transition-colors hover:text-destructive"
                                onClick={() => removeKey(p.id, k.id)}
                                type="button"
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </div>
                        ))}
                        <button
                          className="flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
                          onClick={() => goAddKeyToProvider(p)}
                          type="button"
                        >
                          <Plus className="h-3 w-3" />
                          {t('web.init.addKey')}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <button
              className="panel-subtle flex w-full items-center justify-center gap-1.5 border-dashed py-2.5 text-muted-foreground text-sm transition-colors hover:border-foreground/30 hover:text-foreground"
              onClick={goPickType}
              type="button"
            >
              <Plus className="h-4 w-4" />
              {t('web.init.addProvider')}
            </button>

            {saveError && (
              <p className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-destructive text-xs">
                {saveError}
              </p>
            )}

            <div className="flex items-center justify-between">
              <button
                className="text-muted-foreground text-xs hover:text-foreground"
                onClick={() => setStep('home')}
                type="button"
              >
                {t('web.init.back')}
              </button>
              <Button
                disabled={providers.length === 0}
                onClick={goToModelStep}
                size="sm"
              >
                {t('web.init.continueArrow')}
              </Button>
            </div>
          </div>
        )}

        {step === 'provider' && subStep === 'pick-type' && (
          <div className="flex flex-col gap-4">
            <div className="grid max-h-88 grid-cols-[repeat(auto-fill,minmax(6.75rem,1fr))] gap-2 overflow-y-auto pr-1">
              {providerTypes.map((type) => {
                const pm = metaFor(type);
                const Logo = pm.logo;
                return (
                  <button
                    className={cn(
                      'group flex min-h-20 flex-col items-center justify-center gap-2 rounded-md border border-border/70 bg-card/40 p-2.5 text-center',
                      'transition-[background-color,border-color,color] duration-150 ease-out',
                      'hover:border-foreground/30 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                    )}
                    key={type}
                    onClick={() => pickProviderType(type)}
                    type="button"
                  >
                    <Logo className={cn('size-5 transition-colors duration-150', pm.color || 'text-foreground')} />
                    <span className="line-clamp-2 text-[11px] text-muted-foreground leading-tight transition-colors group-hover:text-foreground">
                      {pm.label}
                    </span>
                  </button>
                );
              })}
            </div>
            <button
              className="text-muted-foreground text-xs hover:text-foreground"
              onClick={() => setSubStep('list')}
              type="button"
            >
              {t('web.init.back')}
            </button>
          </div>
        )}

        {step === 'provider' && subStep === 'add-key' && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-3">
              {showBaseUrlInput && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="base-url">{t('web.init.baseUrl')}</Label>
                  <Input
                    id="base-url"
                    onChange={(e) => {
                      setAddBaseUrl(e.target.value);
                      setAddTested(false);
                    }}
                    placeholder="https://api.example.com/v1"
                    value={addBaseUrl}
                  />
                </div>
              )}
              {addingExistingProvider?.baseUrl && (
                <p className="font-mono text-muted-foreground text-xs">{addingExistingProvider.baseUrl}</p>
              )}

              {extraFields.map((f) => (
                <div
                  className="flex flex-col gap-1.5"
                  key={f.key}
                >
                  <Label htmlFor={`extra-${f.key}`}>{f.label}</Label>
                  <Input
                    id={`extra-${f.key}`}
                    onChange={(e) => {
                      setAddExtra((prev) => ({ ...prev, [f.key]: e.target.value }));
                      setAddTested(false);
                    }}
                    placeholder={f.placeholder}
                    value={addExtra[f.key] ?? ''}
                  />
                </div>
              ))}

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="api-key">
                  {addingMeta.keyOptional ? t('web.init.apiKeyOptional') : t('web.init.apiKey')}
                </Label>
                <Input
                  id="api-key"
                  onChange={(e) => {
                    setAddApiKey(e.target.value);
                    setAddTested(false);
                  }}
                  placeholder={addingMeta.keyPlaceholder ?? 'your-api-key'}
                  {...SECRET_INPUT_PASSWORD_MANAGER_PROPS}
                  value={addApiKey}
                />
              </div>

              {addTested && addModels.length > 0 && (
                <p className="text-muted-foreground text-xs">
                  {t('web.init.modelsFound', { count: addModels.length })}
                </p>
              )}

              {addTestError && (
                <p className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-destructive text-xs">
                  {addTestError}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-3">
              <Button
                className="w-full hover:-translate-y-0.5 active:translate-y-0"
                disabled={isTesting || !canTest}
                onClick={handleTest}
                variant={addTested ? 'outline' : 'default'}
              >
                {isTesting ? (
                  <span className="flex items-center gap-2">
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    {t('web.init.testing')}
                  </span>
                ) : addTested ? (
                  <span className="flex items-center gap-2">
                    <Check className="h-4 w-4" />
                    {t('web.init.verified')}
                  </span>
                ) : (
                  t('web.init.testConnection')
                )}
              </Button>

              <Button
                className="w-full hover:-translate-y-0.5 active:translate-y-0"
                disabled={!canAdd}
                onClick={handleAddKey}
                variant={addTested ? 'default' : 'secondary'}
              >
                <span className="flex items-center gap-2">
                  <Plus className="h-4 w-4" />
                  {t('web.init.addKey')}
                </span>
              </Button>

              <div className="flex justify-start">
                <button
                  className="text-muted-foreground text-xs hover:text-foreground"
                  onClick={() => {
                    resetAddKeyForm();
                    setSubStep(addingToProviderId ? 'list' : 'pick-type');
                  }}
                  type="button"
                >
                  {t('web.init.back')}
                </button>
              </div>
            </div>
          </div>
        )}

        {step === 'model' && (
          <div className="flex flex-col gap-4">
            {(() => {
              const activeProvider = providers.find((p) => p.id === selectedProviderId) ?? providers[0];
              const activeProviderMeta = activeProvider ? metaFor(activeProvider.type as ModelProviderType) : null;
              const q = modelFilter.trim().toLowerCase();
              const providerModels = activeProvider?.models.map((m) => ({ provider: activeProvider, model: m })) ?? [];
              const filtered = providerModels.filter(
                ({ model: m }) => !q || (m.label ?? m.id).toLowerCase().includes(q) || m.id.toLowerCase().includes(q)
              );
              return (
                <>
                  <div className="grid grid-cols-[repeat(auto-fit,minmax(8rem,1fr))] gap-2">
                    {providers.map((p) => {
                      const pm = metaFor(p.type as ModelProviderType);
                      const Logo = pm?.logo;
                      const selected = (selectedProviderId || providers[0]?.id) === p.id;
                      return (
                        <button
                          className={cn(
                            'panel-subtle flex min-w-0 items-center gap-2 px-3 py-2 text-left transition-[background-color,border-color,color] duration-150',
                            selected ? 'border-foreground/40 bg-accent text-foreground' : 'hover:bg-muted/50'
                          )}
                          key={p.id}
                          onClick={() => {
                            setSelectedProviderId(p.id);
                            setSelectedModelId('');
                            setModelFilter('');
                          }}
                          type="button"
                        >
                          {Logo && <Logo className={cn('size-4 shrink-0', pm?.color)} />}
                          <span className="min-w-0 flex-1 truncate text-sm">{pm?.label ?? p.type}</span>
                          {p.models.length > 0 ? (
                            <span className="font-mono text-[10px] text-muted-foreground">{p.models.length}</span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                  <Input
                    autoFocus
                    onChange={(e) => {
                      setModelFilter(e.target.value);
                      setSelectedModelId('');
                      setSelectedProviderId(activeProvider?.id ?? '');
                    }}
                    placeholder={
                      providerModels.length > 0
                        ? `${t('web.init.modelFilter')} ${activeProviderMeta?.label ?? ''}`.trim()
                        : t('web.init.modelPlaceholder')
                    }
                    value={modelFilter}
                  />
                  {filtered.length > 0 && (
                    <div className="flex max-h-60 flex-col gap-1 overflow-y-auto pr-1">
                      {filtered.map(({ provider: p, model: m }) => {
                        const pm = metaFor(p.type as ModelProviderType);
                        const Logo = pm?.logo;
                        const isSelected = selectedProviderId === p.id && selectedModelId === m.id;
                        return (
                          <button
                            className={cn(
                              'panel-subtle flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-all duration-200',
                              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                              isSelected
                                ? 'border-foreground/40 bg-accent font-medium shadow-sm'
                                : 'border-transparent hover:translate-x-0.5 hover:border-border hover:bg-muted/50'
                            )}
                            key={`${p.id}:${m.id}`}
                            onClick={() => {
                              setSelectedProviderId(p.id);
                              setSelectedModelId(m.id);
                              setModelFilter(m.label ?? m.id);
                            }}
                            type="button"
                          >
                            {Logo && <Logo className={cn('h-3.5 w-3.5 shrink-0', pm?.color)} />}
                            <span className="truncate">{m.label ?? m.id}</span>
                            {isSelected && <Check className="ml-auto h-3.5 w-3.5 shrink-0 animate-init-pop" />}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </>
              );
            })()}

            {saveError && (
              <p className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-destructive text-xs">
                {saveError}
              </p>
            )}

            <div className="flex items-center justify-between">
              <button
                className="text-muted-foreground text-xs hover:text-foreground"
                onClick={() => setStep('provider')}
                type="button"
              >
                {t('web.init.back')}
              </button>
              <Button
                disabled={(!selectedModelId && !modelFilter.trim()) || saving}
                onClick={handleSave}
                size="sm"
              >
                {saving ? (
                  <span className="flex items-center gap-2">
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    {t('web.init.saving')}
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5">{t('web.init.next')}</span>
                )}
              </Button>
            </div>
          </div>
        )}

        {step === 'agent' && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="agent-name">{t('web.init.agentName')}</Label>
              <Input
                id="agent-name"
                onChange={(e) => setAgentName(e.target.value)}
                placeholder={t('web.init.agentNamePlaceholder')}
                value={agentName}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="agent-capabilities">
                {t('web.init.capabilities')}{' '}
                <span className="text-muted-foreground">{t('web.init.capabilitiesHint')}</span>
              </Label>
              <Input
                id="agent-capabilities"
                onChange={(e) => setAgentCapabilities(e.target.value)}
                placeholder={t('web.init.capabilitiesPlaceholder')}
                value={agentCapabilities}
              />
            </div>
            {savedModelAlias && (
              <p className="text-muted-foreground text-xs">
                {t('web.init.usingProfile')} <span className="font-mono">{savedModelAlias}</span>
              </p>
            )}

            {agentError && (
              <p className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-destructive text-xs">
                {agentError}
              </p>
            )}

            <div className="flex items-center justify-between">
              <button
                className="text-muted-foreground text-xs hover:text-foreground"
                onClick={() => setStep('model')}
                type="button"
              >
                {t('web.init.back')}
              </button>
              <Button
                disabled={!agentName.trim() || agentSaving}
                onClick={async () => {
                  setAgentError('');
                  setAgentSaving(true);
                  try {
                    if (existingDefaultAgentId) {
                      // Agent already exists — re-affirm the default and finish.
                      await setDefaultAgent({ agentId: existingDefaultAgentId });
                    } else {
                      const result = await createAgent({
                        name: agentName.trim(),
                        capabilities: agentCapabilities
                          .split(',')
                          .map((c) => c.trim())
                          .filter(Boolean),
                        ...(savedModelAlias ? { modelAlias: savedModelAlias } : {})
                      });
                      if ('error' in result) throw new Error(String(result.error));
                      if (result.data?.agent?.id) {
                        await setDefaultAgent({ agentId: result.data.agent.id });
                      }
                    }
                    setDone(true);
                  } catch (e) {
                    setAgentError(e instanceof Error ? e.message : t('web.init.agentError'));
                  } finally {
                    setAgentSaving(false);
                  }
                }}
                size="sm"
              >
                {agentSaving ? (
                  <span className="flex items-center gap-2">
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    {t('web.init.creating')}
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5">
                    <Check className="h-3.5 w-3.5" />
                    {t('web.init.complete')}
                  </span>
                )}
              </Button>
            </div>
          </div>
        )}
      </div>
    </>
  );

  return (
    <>
      <InitBackground />
      <div className="flex min-h-screen items-center justify-center px-4 py-6 lg:px-8">
        <div className="grid min-h-[calc(100vh-3rem)] w-full max-w-6xl grid-cols-1 items-center gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(420px,520px)]">
          <div className="flex min-h-76 items-center justify-center lg:min-h-[560px]">
            <InitLogoCanvas />
          </div>
          <div className="app-frame flex w-full animate-init-rise flex-col gap-4 p-6 sm:p-7">
            {renderWizardContent()}
          </div>
        </div>
      </div>
    </>
  );
}
