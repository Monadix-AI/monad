'use client';

import { httpUrlSchema, type ModelInfo, type ModelProviderType, type ProviderView } from '@monad/protocol';
import { Button, Card, cn, Input, Label, Tooltip, TooltipContent, TooltipTrigger } from '@monad/ui';
import { AlertTriangle, ArrowLeft, Loader2, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useModelSettings, useProviderDetail } from '@/hooks/use-model-settings';
import { providerLogo, useProviderMeta } from '@/lib/ProviderMeta';
import { ModelHoverCardBody, modelMatchesQuery, sortModelsForProvider } from './model-picker';
import {
  initialProviderDialogStep,
  providerDialogCanGoBack,
  providerDialogNextStep,
  providerDialogPreviousStep
} from './provider-dialog-flow';
import { SECRET_INPUT_PASSWORD_MANAGER_PROPS } from './secret-input-props';
import { type AddForm, emptyAddForm, FormMsg, StatusDot, toErrorMessage } from './shared';

function ProviderModelCard({ model }: { model: ModelInfo }) {
  return (
    <div className="glass-foreground min-w-0 rounded-(--radius-sm) border border-border/60 p-3">
      <ModelHoverCardBody model={model} />
    </div>
  );
}

function ProviderModelGrid({ models }: { models: ModelInfo[] }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {models.map((model) => (
        <ProviderModelCard
          key={model.id}
          model={model}
        />
      ))}
    </div>
  );
}

export function ProviderCard({
  deleteDisabledReason,
  onDelete,
  onEdit,
  provider: p
}: {
  deleteDisabledReason?: string;
  onDelete: () => void;
  onEdit: () => void;
  provider: ProviderView;
}) {
  const { metaFor } = useProviderMeta();
  const meta = metaFor(p.type);
  const Logo = meta.logo;
  const detail = useProviderDetail(p.id);

  const credCount = detail.credentials.length;
  const okCount = detail.credentials.filter((c) => c.lastStatus === 'ok').length;
  const errCount = detail.credentials.filter((c) => c.lastStatus === 'error').length;
  const modelCount = detail.models.length;

  const credDotColor =
    credCount === 0
      ? 'bg-muted-foreground/40'
      : okCount > 0
        ? 'bg-success'
        : errCount > 0
          ? 'bg-destructive'
          : 'bg-muted-foreground/60';

  return (
    <Card className="group gap-0 overflow-hidden py-0 transition-colors hover:bg-muted/20">
      <div className="flex min-h-12 items-center gap-2.5 px-3 py-2">
        <Logo className={cn('size-4 shrink-0', meta.color)} />
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="min-w-0 truncate font-medium text-sm">{p.label}</span>
          <span className="flex shrink-0 items-center gap-1 text-muted-foreground text-xs">
            <span className={cn('inline-block size-1.5 shrink-0 rounded-full', credDotColor)} />
            {credCount === 0 ? 'No keys' : `${credCount} key${credCount > 1 ? 's' : ''}`}
            {okCount > 0 && errCount > 0 && <span className="text-destructive">({errCount} err)</span>}
          </span>
          {modelCount > 0 && (
            <span className="shrink-0 text-muted-foreground text-xs">{modelCount.toLocaleString()} models</span>
          )}
          {detail.isLoadingModels && modelCount === 0 && (
            <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
          )}
          {p.baseUrl && <span className="min-w-0 truncate text-muted-foreground/60 text-xs">{p.baseUrl}</span>}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <Button
            aria-label="Edit provider"
            className="size-7 text-muted-foreground hover:text-foreground"
            onClick={onEdit}
            size="icon"
            variant="ghost"
          >
            <Pencil />
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Button
                  aria-label="Delete provider"
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
        </div>
      </div>
    </Card>
  );
}

export function ProviderDialog({
  mode,
  open,
  onClose,
  provider,
  providers,
  settings,
  metaFor,
  PROVIDER_TYPES
}: {
  mode: 'add' | 'edit';
  open: boolean;
  onClose: () => void;
  provider?: ProviderView;
  providers: ProviderView[];
  settings: ReturnType<typeof useModelSettings>;
  metaFor: ReturnType<typeof useProviderMeta>['metaFor'];
  PROVIDER_TYPES: { value: ModelProviderType; label: string; needsUrl: boolean }[];
}) {
  const t = useT();
  const detail = useProviderDetail(provider?.id ?? '');

  const [step, setStep] = useState(initialProviderDialogStep(mode));
  const [form, setForm] = useState<AddForm>(emptyAddForm);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [hasTestedProvider, setHasTestedProvider] = useState(false);
  const [testedModels, setTestedModels] = useState<typeof detail.models>([]);
  const [baseUrlError, setBaseUrlError] = useState<string | null>(null);

  const [addingKey, setAddingKey] = useState(false);
  const [keyLabel, setKeyLabel] = useState('');
  const [keyToken, setKeyToken] = useState('');
  const [keyTesting, setKeyTesting] = useState(false);
  const [keyMsg, setKeyMsg] = useState<string | null>(null);
  const [credTest, setCredTest] = useState<Record<string, string>>({});
  const [modelFilter, setModelFilter] = useState('');

  const updateAddForm = (next: (form: AddForm) => AddForm) => {
    setForm(next);
    setTestMsg(null);
    setBaseUrlError(null);
    setHasTestedProvider(false);
    setTestedModels([]);
  };
  useEffect(() => {
    if (!open) {
      setStep(initialProviderDialogStep(mode));
      setForm(emptyAddForm());
      setTestMsg(null);
      setBaseUrlError(null);
      setTesting(false);
      setHasTestedProvider(false);
      setTestedModels([]);
      setAddingKey(false);
      setKeyLabel('');
      setKeyToken('');
      setKeyMsg(null);
      setCredTest({});
      setModelFilter('');
      return;
    }
    setStep(initialProviderDialogStep(mode));
  }, [open, mode]);

  const providerFromForm = (baseUrlOverride?: string): ProviderView => {
    const taken = new Set(providers.map((p) => p.id));
    let id: string = form.type;
    let n = 2;
    while (taken.has(id)) id = `${form.type}-${n++}`;
    const friendly = metaFor(form.type).label;
    const label = n > 2 ? `${friendly} ${n - 1}` : friendly;
    const baseUrl = baseUrlOverride ?? form.baseUrl.trim();
    return { id, label, type: form.type, baseUrl: baseUrl || undefined };
  };

  const validateBaseUrl = (): { baseUrl?: string; ok: true } | { ok: false } => {
    if (!metaFor(form.type).needsUrl) {
      setBaseUrlError(null);
      return { ok: true };
    }

    const trimmed = form.baseUrl.trim();
    if (!trimmed) {
      setBaseUrlError(t('web.url.required'));
      return { ok: false };
    }
    const parsed = httpUrlSchema.safeParse(trimmed);
    if (!parsed.success) {
      setBaseUrlError(t('web.url.httpOnly'));
      return { ok: false };
    }
    setBaseUrlError(null);
    return { baseUrl: parsed.data, ok: true };
  };

  const handleNext = () => {
    const valid = validateBaseUrl();
    if (!valid.ok) return;
    if (valid.baseUrl && valid.baseUrl !== form.baseUrl) {
      setForm((current) => ({ ...current, baseUrl: valid.baseUrl ?? '' }));
    }
    setStep((current) => providerDialogNextStep(mode, current));
  };

  const handleTestProvider = async () => {
    if (!form.key) {
      setTestMsg(t('web.model.enterKey'));
      return;
    }
    const valid = validateBaseUrl();
    if (!valid.ok) return;
    const prov = providerFromForm(valid.baseUrl);

    setTesting(true);
    setTestMsg(t('web.model.testing'));
    setHasTestedProvider(false);
    setTestedModels([]);
    try {
      const test = await settings.testConnection(prov, form.key);
      if (!test.ok) {
        setTestMsg(`✗ ${test.error ?? t('web.model.connFailed')}`);
        return;
      }
      setTestedModels(test.models ?? []);
      setHasTestedProvider(true);
      setTestMsg(null);
    } catch (e) {
      setTestMsg(`✗ ${toErrorMessage(e)}`);
    } finally {
      setTesting(false);
    }
  };

  const handleAddTestedProvider = async () => {
    if (!form.key || !hasTestedProvider) return;
    try {
      await settings.addProvider(
        providerFromForm(),
        { label: 'key 1', accessToken: form.key },
        { models: testedModels }
      );
      onClose();
    } catch (e) {
      setTestMsg(`✗ ${toErrorMessage(e)}`);
    }
  };

  const handleAddKey = async () => {
    if (!keyLabel || !keyToken || !provider) {
      setKeyMsg(t('web.model.labelKeyRequired'));
      return;
    }
    setKeyTesting(true);
    setKeyMsg('testing...');
    try {
      const res = await settings.testConnection(provider, keyToken);
      if (!res.ok) {
        setKeyMsg(`✗ ${res.error ?? t('web.model.keyFailed')}`);
        return;
      }
      await detail.addCredential(keyLabel, keyToken);
      setAddingKey(false);
      setKeyLabel('');
      setKeyToken('');
      setKeyMsg(null);
    } catch (e) {
      setKeyMsg(`✗ ${toErrorMessage(e)}`);
    } finally {
      setKeyTesting(false);
    }
  };

  const handleTestKey = async (credId: string) => {
    setCredTest((prev) => ({ ...prev, [credId]: '...' }));
    try {
      const res = await detail.testCredential(credId);
      setCredTest((prev) => ({
        ...prev,
        [credId]: res.ok ? `ok ${res.latencyMs ?? '?'}ms` : `fail: ${res.error ?? '?'}`
      }));
    } catch (e) {
      setCredTest((prev) => ({ ...prev, [credId]: toErrorMessage(e) }));
    }
  };

  const selectedMeta = metaFor(form.type);
  const selectedProvider: ProviderView = {
    id: form.type,
    label: selectedMeta.label,
    type: form.type,
    baseUrl: form.baseUrl || undefined
  };
  const activeProvider = mode === 'add' ? selectedProvider : provider;
  const provMeta = activeProvider ? metaFor(activeProvider.type) : null;
  const Logo = provMeta?.logo;
  const configuredModels = mode === 'add' ? testedModels : detail.models;
  const configuredVisibleModels = sortModelsForProvider(
    configuredModels.filter((m) => modelMatchesQuery(m, modelFilter)),
    activeProvider?.type
  );
  const visibleModelLimit = configuredVisibleModels.slice(0, 50);
  const canGoBack = providerDialogCanGoBack(mode, step);

  return (
    <Dialog
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
      open={open}
    >
      <DialogContent className="flex max-h-[72vh] min-h-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle className="flex items-center gap-2 font-semibold text-base">
            {canGoBack && (
              <Button
                aria-label={t('web.common.back')}
                className="-ml-2 size-7"
                onClick={() => setStep((current) => providerDialogPreviousStep(mode, current))}
                size="icon"
                variant="ghost"
              >
                <ArrowLeft />
              </Button>
            )}
            {Logo && provMeta ? <Logo className={cn('size-4 shrink-0', provMeta.color)} /> : null}
            {mode === 'add' ? t('web.model.addProviderTitle') : (provider?.label ?? '')}
          </DialogTitle>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col gap-5 p-5">
            {mode === 'add' && step === 'select' ? (
              <>
                <div className="grid gap-2 sm:grid-cols-3">
                  {PROVIDER_TYPES.map((p) => {
                    const { logo: PrvLogo, color } = providerLogo(p.value);
                    const active = form.type === p.value;
                    return (
                      <button
                        className={cn(
                          'glass-foreground flex min-h-12 items-center gap-2 rounded-md border px-3 py-2 text-left transition-colors',
                          active
                            ? 'border-primary/45 bg-primary/8 text-foreground'
                            : 'border-border/70 bg-card hover:border-ring hover:bg-accent'
                        )}
                        key={p.value}
                        onClick={() => updateAddForm((f) => ({ ...f, type: p.value, baseUrl: '' }))}
                        type="button"
                      >
                        <PrvLogo className={cn('size-4 shrink-0', color)} />
                        <span className="min-w-0 flex-1 truncate font-medium text-sm">{p.label}</span>
                      </button>
                    );
                  })}
                </div>

                <div className="grid gap-3">
                  {selectedMeta.needsUrl && (
                    <div className="flex flex-col gap-1.5">
                      <Label>{t('web.model.baseUrl')}</Label>
                      <Popover open={!!baseUrlError}>
                        <PopoverTrigger asChild>
                          <Input
                            aria-invalid={!!baseUrlError || undefined}
                            autoComplete="url"
                            className="glass-foreground"
                            inputMode="url"
                            onChange={(e) => updateAddForm((f) => ({ ...f, baseUrl: e.target.value }))}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault();
                                handleNext();
                              }
                            }}
                            placeholder="https://…"
                            spellCheck={false}
                            type="url"
                            value={form.baseUrl}
                          />
                        </PopoverTrigger>
                        <PopoverContent
                          align="start"
                          className="w-auto max-w-72 border-destructive/40 bg-destructive/8 px-3 py-2 text-destructive"
                          onOpenAutoFocus={(e) => e.preventDefault()}
                          side="bottom"
                        >
                          <p className="flex items-center gap-1.5 text-sm">
                            <AlertTriangle className="size-3.5 shrink-0" />
                            {baseUrlError}
                          </p>
                        </PopoverContent>
                      </Popover>
                    </div>
                  )}
                </div>
                <div className="flex items-center justify-end gap-2">
                  <Button
                    onClick={onClose}
                    size="sm"
                    variant="ghost"
                  >
                    {t('web.common.cancel')}
                  </Button>
                  <Button
                    onClick={handleNext}
                    size="sm"
                  >
                    {t('web.common.next')}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <section className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                      {t('web.model.keys')}
                    </span>
                    {mode === 'edit' && (
                      <Button
                        onClick={() => {
                          setAddingKey((v) => !v);
                          setKeyMsg(null);
                          setKeyLabel('');
                          setKeyToken('');
                        }}
                        size="sm"
                        variant="ghost"
                      >
                        {addingKey ? (
                          t('web.model.cancel')
                        ) : (
                          <>
                            <Plus /> {t('web.model.keyBtn')}
                          </>
                        )}
                      </Button>
                    )}
                  </div>

                  {mode === 'edit' && addingKey && (
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        className="glass-foreground h-8 w-32"
                        onChange={(e) => setKeyLabel(e.target.value)}
                        placeholder={t('web.model.labelPlaceholder')}
                        value={keyLabel}
                      />
                      <Input
                        className="glass-foreground h-8 min-w-48 flex-1 [-webkit-text-security:disc]"
                        onChange={(e) => setKeyToken(e.target.value)}
                        placeholder={t('web.model.apiKeyPlaceholder')}
                        value={keyToken}
                        {...SECRET_INPUT_PASSWORD_MANAGER_PROPS}
                      />
                      <Button
                        disabled={keyTesting}
                        onClick={() => void handleAddKey()}
                        size="sm"
                      >
                        {keyTesting ? <Loader2 className="animate-spin" /> : t('web.model.test')}
                      </Button>
                      {keyMsg && <FormMsg msg={keyMsg} />}
                    </div>
                  )}

                  {mode === 'add' && (
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        className="glass-foreground h-8 min-w-48 flex-1 [-webkit-text-security:disc]"
                        onChange={(e) => updateAddForm((f) => ({ ...f, key: e.target.value }))}
                        placeholder={t('web.model.apiKeyPlaceholder')}
                        value={form.key}
                        {...SECRET_INPUT_PASSWORD_MANAGER_PROPS}
                      />
                      <Button
                        disabled={testing}
                        onClick={() => void handleTestProvider()}
                        size="sm"
                      >
                        {testing ? (
                          <>
                            <Loader2 className="animate-spin" /> {t('web.model.testing')}
                          </>
                        ) : (
                          t('web.model.test')
                        )}
                      </Button>
                      {hasTestedProvider && (
                        <Button
                          onClick={() => void handleAddTestedProvider()}
                          size="sm"
                        >
                          {t('web.model.addProvider')}
                        </Button>
                      )}
                      {testMsg && <FormMsg msg={testMsg} />}
                    </div>
                  )}

                  {mode === 'edit' && detail.credentials.length === 0 && !addingKey && (
                    <p className="text-muted-foreground text-xs">{t('web.model.noKeys')}</p>
                  )}

                  {mode === 'edit' &&
                    detail.credentials.map((c) => {
                      const result = credTest[c.id];
                      return (
                        <div
                          className="glass-foreground flex min-h-10 items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm"
                          key={c.id}
                        >
                          <StatusDot status={c.lastStatus} />
                          <span className="inline-flex items-center font-medium leading-none">{c.label}</span>
                          <span className="inline-flex items-center font-mono text-muted-foreground text-xs leading-none">
                            {c.accessTokenPreview ?? '...'}
                          </span>
                          <span className="ml-auto inline-flex items-center text-muted-foreground text-xs leading-none">
                            {t('web.model.req', { count: c.requestCount })}
                          </span>
                          {result && (
                            <span
                              className={cn(
                                'inline-flex items-center text-xs leading-none',
                                result.startsWith('ok') ? 'text-success' : 'text-destructive'
                              )}
                            >
                              {result}
                            </span>
                          )}
                          <Button
                            onClick={() => void handleTestKey(c.id)}
                            size="sm"
                            variant="ghost"
                          >
                            {t('web.model.test')}
                          </Button>
                          <Button
                            aria-label={t('web.model.deleteKey')}
                            className="size-7 text-muted-foreground hover:text-destructive"
                            onClick={() => void detail.deleteCredential(c.id)}
                            size="icon"
                            variant="ghost"
                          >
                            <X />
                          </Button>
                        </div>
                      );
                    })}
                </section>

                {(mode === 'edit' || hasTestedProvider) && (
                  <section className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                        {t('web.model.models')}
                        {configuredModels.length > 0 && (
                          <span className="ml-1 text-muted-foreground/70">({configuredVisibleModels.length})</span>
                        )}
                      </span>
                      {mode === 'edit' && (
                        <Button
                          onClick={detail.refreshModels}
                          size="sm"
                          variant="ghost"
                        >
                          <RefreshCw /> {t('web.model.refresh')}
                        </Button>
                      )}
                    </div>

                    {configuredModels.length > 8 && (
                      <Input
                        className="glass-foreground h-8"
                        onChange={(e) => setModelFilter(e.target.value)}
                        placeholder={t('web.model.filterPlaceholder')}
                        value={modelFilter}
                      />
                    )}

                    {mode === 'edit' && detail.isLoadingModels && configuredModels.length === 0 ? (
                      <p className="text-muted-foreground text-xs">{t('web.model.loadingModels')}</p>
                    ) : configuredVisibleModels.length === 0 ? (
                      <p className="text-muted-foreground text-xs">{t('web.model.noModels')}</p>
                    ) : (
                      <ProviderModelGrid models={visibleModelLimit} />
                    )}
                  </section>
                )}
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
