'use client';

import { Button, cn, Input, Label, ScrollArea, Switch, Textarea } from '@monad/ui';
import { Copy, Loader2, RefreshCw, Send } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { type TFn, useT } from '@/components/I18nProvider';
import { useAsyncAction } from '../hooks/use-async-action';
import { useOpenaiCompatSettings } from '../hooks/use-openai-compat-settings';
import { useMonadRuntime } from '../lib/monad-runtime-provider';
import { StudioPanel, StudioPanelHeader } from './studio/StudioPanel';

export function OpenaiCompatSettings(_props: { onClose: () => void }) {
  const t = useT();
  const { baseUrl: daemonBaseUrl } = useMonadRuntime();
  const { settings, loading, set, refetch } = useOpenaiCompatSettings();
  const { busy, run } = useAsyncAction();
  const [token, setToken] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (settings?.token !== undefined) setToken(settings.token);
  }, [settings?.token]);

  const handleToggle = (enabled: boolean) => {
    void run(() => set({ enabled, token: token || undefined }));
  };

  const handleSaveToken = () => {
    void run(() => set({ enabled: settings?.enabled ?? false, token: token || undefined }));
  };

  const handleCopy = async () => {
    if (!token) return;
    await navigator.clipboard.writeText(token);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <StudioPanel>
      <StudioPanelHeader
        actions={
          <Button
            aria-label={t('web.common.refresh')}
            className="size-7"
            onClick={refetch}
            size="icon"
            variant="ghost"
          >
            <RefreshCw className={cn(loading && 'animate-spin')} />
          </Button>
        }
        subtitle={t('web.api.subtitle')}
        title={t('web.api.title')}
      />

      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-5 p-5">
          <p className="text-muted-foreground text-xs">
            Exposes your agents as models via an OpenAI-compatible HTTP API (
            <code className="font-mono">/openai/v1/models</code> and{' '}
            <code className="font-mono">/openai/v1/chat/completions</code>). Any OpenAI SDK or client can connect by
            pointing <code className="font-mono">base_url</code> at your daemon.
          </p>

          {loading ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <Loader2 className="size-4 animate-spin" />
              {t('web.common.loading')}
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <Switch
                  checked={settings?.enabled ?? false}
                  disabled={busy}
                  id="openai-compat-enabled"
                  onCheckedChange={handleToggle}
                />
                <Label
                  className="text-sm"
                  htmlFor="openai-compat-enabled"
                >
                  {settings?.enabled ? t('web.api.enabled') : t('web.api.disabled')}
                </Label>
                {busy && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
              </div>

              <div className="flex flex-col gap-2">
                <Label
                  className="text-sm"
                  htmlFor="openai-compat-token"
                >
                  {t('web.api.bearerToken')}
                </Label>
                <p className="text-muted-foreground text-xs">{t('web.api.bearerHint')}</p>
                <div className="flex gap-2">
                  <Input
                    className="font-mono text-xs"
                    disabled={busy}
                    id="openai-compat-token"
                    onChange={(e) => setToken(e.target.value)}
                    placeholder={t('web.api.tokenPlaceholder')}
                    type="password"
                    value={token}
                  />
                  <Button
                    disabled={!token}
                    onClick={() => void handleCopy()}
                    size="icon"
                    title={t('web.api.copyToken')}
                    variant="outline"
                  >
                    <Copy className={cn('size-4', copied && 'text-green-500')} />
                  </Button>
                </div>
                <Button
                  className="self-start"
                  disabled={busy}
                  onClick={handleSaveToken}
                  size="sm"
                  variant="outline"
                >
                  {t('web.api.saveToken')}
                </Button>
              </div>

              {settings?.enabled && (
                <TestPanel
                  baseUrl={daemonBaseUrl}
                  t={t}
                  token={token}
                />
              )}
            </>
          )}
        </div>
      </ScrollArea>
    </StudioPanel>
  );
}

function TestPanel({ baseUrl, token, t }: { baseUrl: string; token: string; t: TFn }) {
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ input: string; output: string } | null>(null);
  const [testError, setTestError] = useState<string>();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = async () => {
    const prompt = input.trim();
    if (!prompt || sending) return;

    setSending(true);
    setTestError(undefined);
    setResult(null);

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;

      const res = await fetch(`${baseUrl}/openai/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'default',
          messages: [{ role: 'user', content: prompt }]
        })
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      }

      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const output = data.choices?.[0]?.message?.content ?? '(empty response)';
      setResult({ input: prompt, output });
      setInput('');
    } catch (e) {
      setTestError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void handleSend();
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <p className="font-medium text-xs">{t('web.api.test')}</p>

      <Textarea
        className="min-h-16 resize-none font-mono text-xs"
        disabled={sending}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t('web.api.testPlaceholder')}
        ref={textareaRef}
        value={input}
      />

      <Button
        className="gap-1.5 self-start"
        disabled={!input.trim() || sending}
        onClick={() => void handleSend()}
        size="sm"
      >
        {sending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
        {sending ? t('web.api.sending') : t('web.api.send')}
      </Button>

      {testError && <p className="rounded bg-destructive/10 px-2 py-1 text-destructive text-xs">{testError}</p>}

      {result && (
        <div className="flex flex-col gap-2">
          <div className="rounded bg-muted px-3 py-2">
            <p className="mb-1 text-[10px] text-muted-foreground uppercase tracking-wide">Input</p>
            <p className="whitespace-pre-wrap font-mono text-xs">{result.input}</p>
          </div>
          <div className="rounded bg-muted px-3 py-2">
            <p className="mb-1 text-[10px] text-muted-foreground uppercase tracking-wide">Output</p>
            <p className="whitespace-pre-wrap font-mono text-xs">{result.output}</p>
          </div>
        </div>
      )}
    </div>
  );
}
