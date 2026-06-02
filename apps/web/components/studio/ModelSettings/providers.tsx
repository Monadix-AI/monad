'use client';

import type { ProviderView } from '@monad/protocol';

import { ModelProviderType } from '@monad/protocol';
import {
  Button,
  Card,
  cn,
  Input,
  Label,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@monad/ui';
import { Loader2, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useModelSettings, useProviderDetail } from '@/hooks/use-model-settings';
import { providerLogo, useProviderMeta } from '@/lib/ProviderMeta';
import { type AddForm, emptyAddForm, FormMsg, ModelPriceTag, StatusDot, toErrorMessage } from './shared';

export function ProviderCard({ provider: p, onEdit }: { provider: ProviderView; onEdit: () => void }) {
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
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <Logo className={cn('mt-0.5 size-4 shrink-0', meta.color)} />
        <div className="min-w-0 flex-1">
          <span className="block truncate font-medium text-sm leading-6">{p.label}</span>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground text-xs">
            <span className="flex items-center gap-1">
              <span className={cn('inline-block size-1.5 shrink-0 rounded-full', credDotColor)} />
              {credCount === 0 ? 'No keys' : `${credCount} key${credCount > 1 ? 's' : ''}`}
              {okCount > 0 && errCount > 0 && <span className="text-destructive">({errCount} err)</span>}
            </span>
            {modelCount > 0 && <span>{modelCount.toLocaleString()} models</span>}
            {detail.isLoadingModels && modelCount === 0 && <Loader2 className="size-3 animate-spin" />}
            {p.baseUrl && <span className="max-w-[14rem] truncate opacity-60">{p.baseUrl}</span>}
          </div>
        </div>
        <Button
          aria-label="Edit provider"
          className="mt-0.5 size-7 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
          onClick={onEdit}
          size="icon"
          variant="ghost"
        >
          <Pencil />
        </Button>
      </div>
    </Card>
  );
}

export function ProviderDialog({
  mode,
  open,
  onClose,
  onDelete,
  provider,
  providers,
  settings,
  metaFor,
  PROVIDER_TYPES
}: {
  mode: 'add' | 'edit';
  open: boolean;
  onClose: () => void;
  onDelete?: () => void;
  provider?: ProviderView;
  providers: ProviderView[];
  settings: ReturnType<typeof useModelSettings>;
  metaFor: ReturnType<typeof useProviderMeta>['metaFor'];
  PROVIDER_TYPES: { value: ModelProviderType; label: string; needsUrl: boolean }[];
}) {
  const t = useT();
  const detail = useProviderDetail(provider?.id ?? '');

  const [form, setForm] = useState<AddForm>(emptyAddForm);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);

  const [addingKey, setAddingKey] = useState(false);
  const [keyLabel, setKeyLabel] = useState('');
  const [keyToken, setKeyToken] = useState('');
  const [keyTesting, setKeyTesting] = useState(false);
  const [keyMsg, setKeyMsg] = useState<string | null>(null);
  const [credTest, setCredTest] = useState<Record<string, string>>({});
  const [modelFilter, setModelFilter] = useState('');

  const filter = modelFilter.toLowerCase();
  const allModels = detail.models;
  const visibleModels = allModels.filter((m) => !filter || m.id.toLowerCase().includes(filter));

  useEffect(() => {
    if (!open) {
      setForm(emptyAddForm());
      setTestMsg(null);
      setTesting(false);
      setAddingKey(false);
      setKeyLabel('');
      setKeyToken('');
      setKeyMsg(null);
      setCredTest({});
      setModelFilter('');
    }
  }, [open]);

  const handleTestAndAdd = async () => {
    if (!form.key) {
      setTestMsg(t('web.model.enterKey'));
      return;
    }
    const meta = metaFor(form.type);
    if (meta.needsUrl && !form.baseUrl) {
      setTestMsg(t('web.model.needBaseUrl'));
      return;
    }
    const taken = new Set(providers.map((p) => p.id));
    let id: string = form.type;
    let n = 2;
    while (taken.has(id)) id = `${form.type}-${n++}`;
    const friendly = metaFor(form.type).label;
    const label = n > 2 ? `${friendly} ${n - 1}` : friendly;
    const prov: ProviderView = { id, label, type: form.type, baseUrl: form.baseUrl || undefined };

    setTesting(true);
    setTestMsg(t('web.model.testing'));
    try {
      const test = await settings.testConnection(prov, form.key);
      if (!test.ok) {
        setTestMsg(`✗ ${test.error ?? t('web.model.connFailed')}`);
        return;
      }
      await settings.addProvider(prov, { label: 'key 1', accessToken: form.key }, { models: test.models });
      onClose();
    } catch (e) {
      setTestMsg(`✗ ${toErrorMessage(e)}`);
    } finally {
      setTesting(false);
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

  const provMeta = provider ? metaFor(provider.type) : null;
  const Logo = provMeta?.logo;

  return (
    <Dialog
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
      open={open}
    >
      <DialogContent className="flex max-h-[82vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle className="flex items-center gap-2 font-semibold text-base">
            {Logo && provMeta ? <Logo className={cn('size-4 shrink-0', provMeta.color)} /> : null}
            {mode === 'add' ? t('web.model.addProviderTitle') : (provider?.label ?? '')}
          </DialogTitle>
        </DialogHeader>

        <ScrollArea className="flex-1">
          <div className="flex flex-col gap-5 p-5">
            {mode === 'add' ? (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label>{t('web.model.providerType')}</Label>
                    <Select
                      onValueChange={(v) => setForm((f) => ({ ...f, type: v as ModelProviderType }))}
                      value={form.type}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PROVIDER_TYPES.map((p) => {
                          const { logo: PrvLogo, color } = providerLogo(p.value);
                          return (
                            <SelectItem
                              key={p.value}
                              value={p.value}
                            >
                              <span className="flex items-center gap-2">
                                <PrvLogo className={cn('size-3.5 shrink-0', color)} />
                                {p.label}
                              </span>
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                  </div>
                  {metaFor(form.type).needsUrl && (
                    <div className="flex flex-col gap-1.5">
                      <Label>{t('web.model.baseUrl')}</Label>
                      <Input
                        onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
                        placeholder="https://…"
                        value={form.baseUrl}
                      />
                    </div>
                  )}
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>{t('web.model.apiKey')}</Label>
                  <Input
                    autoComplete="off"
                    onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))}
                    placeholder="sk-…"
                    type="password"
                    value={form.key}
                  />
                </div>
                <div className="flex items-center gap-3">
                  <Button
                    disabled={testing}
                    onClick={() => void handleTestAndAdd()}
                    size="sm"
                  >
                    {testing ? (
                      <>
                        <Loader2 className="animate-spin" /> {t('web.model.testing')}
                      </>
                    ) : (
                      t('web.model.testAdd')
                    )}
                  </Button>
                  {testMsg && <FormMsg msg={testMsg} />}
                </div>
              </>
            ) : (
              <>
                <section className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                      {t('web.model.keys')}
                    </span>
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
                  </div>

                  {addingKey && (
                    <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-2.5">
                      <Input
                        className="h-8 w-32"
                        onChange={(e) => setKeyLabel(e.target.value)}
                        placeholder={t('web.model.labelPlaceholder')}
                        value={keyLabel}
                      />
                      <Input
                        autoComplete="off"
                        className="h-8 min-w-48 flex-1"
                        onChange={(e) => setKeyToken(e.target.value)}
                        placeholder={t('web.model.apiKeyPlaceholder')}
                        type="password"
                        value={keyToken}
                      />
                      <Button
                        disabled={keyTesting}
                        onClick={() => void handleAddKey()}
                        size="sm"
                      >
                        {keyTesting ? <Loader2 className="animate-spin" /> : t('web.model.testAdd')}
                      </Button>
                      {keyMsg && <FormMsg msg={keyMsg} />}
                    </div>
                  )}

                  {detail.credentials.length === 0 && !addingKey && (
                    <p className="text-muted-foreground text-xs">{t('web.model.noKeys')}</p>
                  )}

                  {detail.credentials.map((c) => {
                    const result = credTest[c.id];
                    return (
                      <div
                        className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm"
                        key={c.id}
                      >
                        <StatusDot status={c.lastStatus} />
                        <span className="font-medium">{c.label}</span>
                        <span className="font-mono text-muted-foreground text-xs">{c.accessTokenPreview ?? '...'}</span>
                        <span className="ml-auto text-muted-foreground text-xs">
                          {t('web.model.req', { count: c.requestCount })}
                        </span>
                        {result && (
                          <span
                            className={cn('text-xs', result.startsWith('ok') ? 'text-success' : 'text-destructive')}
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

                <section className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                      {t('web.model.models')}
                      {allModels.length > 0 && (
                        <span className="ml-1 text-muted-foreground/70">({visibleModels.length})</span>
                      )}
                    </span>
                    <Button
                      onClick={detail.refreshModels}
                      size="sm"
                      variant="ghost"
                    >
                      <RefreshCw /> {t('web.model.refresh')}
                    </Button>
                  </div>

                  {allModels.length > 8 && (
                    <Input
                      className="h-8"
                      onChange={(e) => setModelFilter(e.target.value)}
                      placeholder={t('web.model.filterPlaceholder')}
                      value={modelFilter}
                    />
                  )}

                  {detail.isLoadingModels && allModels.length === 0 ? (
                    <p className="text-muted-foreground text-xs">{t('web.model.loadingModels')}</p>
                  ) : visibleModels.length === 0 ? (
                    <p className="text-muted-foreground text-xs">{t('web.model.noModels')}</p>
                  ) : (
                    <div className="grid gap-1.5">
                      {visibleModels.slice(0, 50).map((m) => (
                        <div
                          className="flex items-center gap-2 rounded-md border px-2.5 py-2 text-sm"
                          key={m.id}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium text-xs">{m.label ?? m.id}</span>
                            {m.label && (
                              <span className="block truncate font-mono text-[10px] text-muted-foreground">{m.id}</span>
                            )}
                          </span>
                          {m.price && (
                            <ModelPriceTag
                              className="ml-auto"
                              price={m.price}
                            />
                          )}
                        </div>
                      ))}
                      {visibleModels.length > 50 && (
                        <p className="px-2 py-1 text-muted-foreground text-xs">
                          {t('web.model.moreFiltered', { count: visibleModels.length - 50 })}
                        </p>
                      )}
                    </div>
                  )}
                </section>

                {onDelete && (
                  <div className="border-t pt-3">
                    <Button
                      className="text-destructive hover:text-destructive"
                      onClick={onDelete}
                      size="sm"
                      variant="ghost"
                    >
                      <Trash2 /> {t('web.model.deleteProvider')}
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
