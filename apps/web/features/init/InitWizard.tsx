'use client';

import type { AgentId, ModelInfo, ProviderView } from '@monad/protocol';
import type { DraftKey, DraftProvider } from './InitWizardTypes';

import { zodResolver } from '@hookform/resolvers/zod';
import { CheckIcon, CpuIcon, NeuralNetworkIcon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  agentSelectors,
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
import { Button, Input, Label } from '@monad/ui';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';

import { useT } from '#/components/I18nProvider';
import { providerFormSchema } from '#/lib/form-validation';
import { useMonadRuntime } from '#/lib/monad-runtime-provider';
import { useProviderMeta } from '#/lib/ProviderMeta';
import { SECRET_INPUT_PASSWORD_MANAGER_PROPS } from '#/lib/secret-input-props';
import { InitAgentStep } from './InitAgentStep';
import { InitMeshStep } from './InitMeshStep';
import { InitModelStep } from './InitModelStep';
import { InitProviderListStep, InitProviderTypePickerStep } from './InitProviderSteps';
import { InitDoneView, InitRestartingView, InitWizardFrame, InitWizardHeader } from './InitWizardLayout';

function dedupeModels(ms: ModelInfo[]): ModelInfo[] {
  const seen = new Set<string>();
  return ms.filter((m) => !seen.has(m.id) && !!seen.add(m.id));
}

type Step = 'choice' | 'provider' | 'model' | 'agent' | 'mesh';
type ProviderSubStep = 'list' | 'pick-type' | 'add-key';

export function InitWizard({ homePath }: { homePath?: string }) {
  const t = useT();
  const { client: monadClient } = useMonadRuntime();
  const [step, setStep] = useState<Step>('choice');
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
  const existingAgents = existingAgentsData ? agentSelectors.selectAll(existingAgentsData) : undefined;
  const { data: loadedDefaultAgentData } = useGetDefaultAgentQuery();
  const loadedDefaultAgentId = loadedDefaultAgentData?.agentId;
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    if (seeded || !existingProviders || !existingProfiles || existingAgents === undefined) return;

    async function seed() {
      const loaded = await Promise.all(
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
      // Only seed providers that already carry a credential. This drops the seeded sample
      // placeholder (no credentials) so it can't be pre-selected and carried into a "complete"
      // init that computeInitStatus then rejects as missing a provider/credential.
      const drafts: DraftProvider[] = loaded.filter((p) => p.keys.length > 0);
      if (drafts.length > 0) setProviders(drafts);

      const defaultProfile = existingProfiles
        ? profileSelectors.selectAll(existingProfiles.profiles).find((p) => p.alias === existingProfiles.defaultAlias)
        : undefined;
      // Pre-select only when the default profile points at a credentialed provider we kept.
      if (defaultProfile && drafts.some((p) => p.id === defaultProfile.routes.chat.provider)) {
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
  const addProviderForm = useForm<{ type: string; baseUrl: string }>({
    values: { type: addingType, baseUrl: addBaseUrl },
    resolver: zodResolver(providerFormSchema(showBaseUrlInput))
  });
  const addBaseUrlIssue = addProviderForm.formState.errors.baseUrl?.message;
  const addBaseUrlError = addBaseUrlIssue
    ? addBaseUrlIssue === 'url required'
      ? t('web.url.required')
      : t('web.url.httpOnly')
    : '';

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

  const enterMonad = () => window.location.assign('/');

  async function handleSetHome(nextStep: Step) {
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
    setStep(nextStep);
  }

  async function handleTest() {
    setAddTestError('');
    setAddTested(false);
    await addProviderForm.handleSubmit(async ({ baseUrl: parsedBaseUrl }) => {
      if (parsedBaseUrl !== addBaseUrl) setAddBaseUrl(parsedBaseUrl);
      const baseUrl = addingExistingProvider?.baseUrl ?? (showBaseUrlInput ? parsedBaseUrl : undefined);
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
    })();
  }

  function handleAddKey() {
    void addProviderForm.handleSubmit(({ baseUrl: parsedBaseUrl }) => {
      if (parsedBaseUrl !== addBaseUrl) setAddBaseUrl(parsedBaseUrl);
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
            baseUrl: parsedBaseUrl || undefined,
            ...(newExtra ? { extra: newExtra } : {}),
            keys: [newKey],
            models: discoveredModels
          }
        ];
      });

      resetAddKeyForm();
      setSubStep('list');
    })();
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
        // .unwrap() so a rejected write throws here instead of being silently swallowed — otherwise
        // init would advance with nothing persisted and the home page reports "missing provider".
        if (!existingProviderIds.has(p.id)) await setProvider(pv).unwrap();
        for (const k of p.keys) {
          if (k.saved) continue; // already persisted — don't create a duplicate
          await addCredential({
            providerId: p.id,
            label: `${label} key`,
            authType: 'api_key',
            accessToken: k.accessToken,
            ...(p.baseUrl ? { baseUrl: p.baseUrl } : {})
          }).unwrap();
        }
      }

      const effectiveProviderId = selectedProviderId || providers[0]?.id || '';
      const effectiveModelId = selectedModelId || modelFilter.trim();
      // The default profile MUST point at a real provider+model for init to count as complete
      // (computeInitStatus keys off it). Refuse to advance without one rather than finishing into a
      // state the home page rejects as uninitialized.
      if (!effectiveProviderId || !effectiveModelId) {
        throw new Error(t('web.init.modelRequired'));
      }
      const alias = 'default';
      await setProfile({
        alias,
        routes: { chat: { provider: effectiveProviderId, modelId: effectiveModelId } },
        params: {},
        fallbacks: []
      }).unwrap();
      await setDefault({ alias }).unwrap();
      setSavedModelAlias(alias);
      setStep('agent');
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : t('web.init.saveError'));
    } finally {
      setSaving(false);
    }
  }

  async function handleAgentSave() {
    setAgentError('');
    setAgentSaving(true);
    try {
      if (existingDefaultAgentId) {
        await setDefaultAgent({ agentId: existingDefaultAgentId }).unwrap();
      } else {
        const result = await createAgent({
          name: agentName.trim(),
          capabilities: agentCapabilities
            .split(',')
            .map((capability) => capability.trim())
            .filter(Boolean),
          ...(savedModelAlias ? { modelAlias: savedModelAlias } : {})
        });
        if ('error' in result) throw new Error(String(result.error));
        if (result.data?.agent?.id) {
          await setDefaultAgent({ agentId: result.data.agent.id }).unwrap();
        }
      }
      setDone(true);
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : t('web.init.agentError'));
    } finally {
      setAgentSaving(false);
    }
  }

  if (restarting) {
    return <InitRestartingView t={t} />;
  }

  if (done) {
    return <InitDoneView t={t} />;
  }

  const title =
    step === 'choice'
      ? t('web.init.titleChoice')
      : step === 'mesh'
        ? t('web.init.titleMesh')
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
    step === 'choice'
      ? t('web.init.descChoice')
      : step === 'mesh'
        ? t('web.init.descMesh')
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

  const stepIndex = step === 'choice' ? 0 : step === 'provider' || step === 'mesh' ? 1 : step === 'model' ? 2 : 3;

  const renderWizardContent = () => (
    <>
      <InitWizardHeader
        description={description}
        stepIndex={stepIndex}
        t={t}
        title={title}
      />

      {/* keyed so each transition replays a soft cross-fade */}
      <div
        className="animate-init-fade"
        key={`${step}:${subStep}`}
      >
        {step === 'choice' && (
          <div className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <button
                className="panel-subtle flex min-h-40 flex-col items-start gap-4 px-4 py-4 text-left transition hover:-translate-y-0.5 hover:border-foreground/30 hover:bg-accent active:translate-y-0"
                onClick={() => void handleSetHome('provider')}
                type="button"
              >
                <span className="flex size-10 items-center justify-center rounded-md border bg-background">
                  <HugeiconsIcon
                    className="size-5"
                    icon={CpuIcon}
                  />
                </span>
                <span className="min-w-0">
                  <span className="block font-medium text-base">{t('web.init.runtimePileTitle')}</span>
                  <span className="mt-2 block text-muted-foreground text-sm">{t('web.init.runtimePileDesc')}</span>
                </span>
              </button>
              <button
                className="panel-subtle flex min-h-40 flex-col items-start gap-4 px-4 py-4 text-left transition hover:-translate-y-0.5 hover:border-foreground/30 hover:bg-accent active:translate-y-0"
                onClick={() => void handleSetHome('mesh')}
                type="button"
              >
                <span className="flex size-10 items-center justify-center rounded-md border bg-background">
                  <HugeiconsIcon
                    className="size-5"
                    icon={NeuralNetworkIcon}
                  />
                </span>
                <span className="min-w-0">
                  <span className="block font-medium text-base">{t('web.init.meshPileTitle')}</span>
                  <span className="mt-2 block text-muted-foreground text-sm">{t('web.init.meshPileDesc')}</span>
                </span>
              </button>
            </div>
            <details className="rounded-md border bg-muted/20">
              <summary className="cursor-pointer px-3 py-2 text-muted-foreground text-xs hover:text-foreground">
                {t('web.init.homeAdvanced')}
              </summary>
              <div className="flex flex-col gap-2 border-t px-3 py-3">
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
            </details>
            <Button
              className="self-start"
              onClick={enterMonad}
              size="sm"
              variant="ghost"
            >
              {t('web.init.enterMonad')}
            </Button>
          </div>
        )}

        {step === 'provider' && subStep === 'list' && (
          <InitProviderListStep
            goAddKeyToProvider={goAddKeyToProvider}
            goPickType={goPickType}
            goToModelStep={goToModelStep}
            metaFor={metaFor}
            onBack={() => setStep('choice')}
            onSkip={enterMonad}
            providers={providers}
            removeKey={removeKey}
            saveError={saveError}
            t={t}
          />
        )}

        {step === 'mesh' && (
          <InitMeshStep
            onBack={() => setStep('choice')}
            onEnter={enterMonad}
            t={t}
          />
        )}

        {step === 'provider' && subStep === 'pick-type' && (
          <InitProviderTypePickerStep
            metaFor={metaFor}
            onBack={() => setSubStep('list')}
            pickProviderType={pickProviderType}
            providerTypes={providerTypes}
            t={t}
          />
        )}

        {step === 'provider' && subStep === 'add-key' && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-3">
              {showBaseUrlInput && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="base-url">{t('web.init.baseUrl')}</Label>
                  <Input
                    aria-invalid={!!addBaseUrlError || undefined}
                    id="base-url"
                    onChange={(e) => {
                      setAddBaseUrl(e.target.value);
                      addProviderForm.clearErrors('baseUrl');
                      setAddTested(false);
                    }}
                    placeholder="https://api.example.com/v1"
                    value={addBaseUrl}
                  />
                  {addBaseUrlError && <p className="text-destructive text-xs">{addBaseUrlError}</p>}
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
                    <HugeiconsIcon
                      className="h-4 w-4"
                      icon={CheckIcon}
                    />
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
                  <HugeiconsIcon
                    className="h-4 w-4"
                    icon={PlusSignIcon}
                  />
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
          <div className="flex flex-col gap-3">
            <InitModelStep
              metaFor={metaFor}
              modelFilter={modelFilter}
              onBack={() => setStep('provider')}
              onSave={handleSave}
              providers={providers}
              saveError={saveError}
              saving={saving}
              selectedModelId={selectedModelId}
              selectedProviderId={selectedProviderId}
              setModelFilter={setModelFilter}
              setSelectedModelId={setSelectedModelId}
              setSelectedProviderId={setSelectedProviderId}
              t={t}
            />
            <Button
              className="self-end"
              onClick={enterMonad}
              size="sm"
              variant="ghost"
            >
              {t('web.init.skipForNow')}
            </Button>
          </div>
        )}

        {step === 'agent' && (
          <InitAgentStep
            agentCapabilities={agentCapabilities}
            agentError={agentError}
            agentName={agentName}
            agentSaving={agentSaving}
            onBack={() => setStep('model')}
            onSave={() => void handleAgentSave()}
            onSkip={enterMonad}
            savedModelAlias={savedModelAlias}
            setAgentCapabilities={setAgentCapabilities}
            setAgentName={setAgentName}
          />
        )}
      </div>
    </>
  );

  return <InitWizardFrame>{renderWizardContent()}</InitWizardFrame>;
}
