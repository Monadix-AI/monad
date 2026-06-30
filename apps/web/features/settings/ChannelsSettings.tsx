'use client';

import type { ChannelAccessPolicy, ChannelId, ChannelInstanceView } from '@monad/protocol';

import { useApproveChannelPairingMutation, useListChannelPairingsQuery } from '@monad/client-rtk';
import { newId } from '@monad/protocol';
import {
  Badge,
  Button,
  cn,
  Input,
  Label,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea
} from '@monad/ui';
import {
  Check,
  ChevronDown,
  ChevronRight,
  KeyRound,
  Loader2,
  Plus,
  Power,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X
} from 'lucide-react';
import { useState } from 'react';

import { I18nTrans, useT } from '@/components/I18nProvider';
import { PanelShell, PanelShellHeader } from '@/components/ui/panel-shell';
import { useAsyncAction } from '@/hooks/use-async-action';
import { useChannelSettings } from '@/hooks/use-channel-settings';
import { SECRET_INPUT_PASSWORD_MANAGER_PROPS } from '@/lib/secret-input-props';

const KNOWN_TYPES = ['telegram', 'slack', 'discord'];
export function ChannelsSettings(_props: { onClose: () => void }) {
  const t = useT();
  const { channels, statusById, loading, saveChannel, removeChannel, setEnabled, setToken, refetch } =
    useChannelSettings();
  const [adding, setAdding] = useState(false);

  return (
    <PanelShell>
      <PanelShellHeader
        actions={
          <>
            <Button
              aria-label={t('web.refresh')}
              className="size-7"
              onClick={refetch}
              size="icon"
              variant="ghost"
            >
              <RefreshCw className={cn(loading && 'animate-spin')} />
            </Button>
            <Button
              aria-label={t('web.ch.addChannel')}
              className="size-7"
              onClick={() => setAdding(true)}
              size="icon"
              variant="ghost"
            >
              <Plus />
            </Button>
          </>
        }
        subtitle={t('web.ch.subtitle')}
        title={t('web.ch.title')}
      />

      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-2 p-4">
          {adding ? (
            <AddChannelForm
              onCancel={() => setAdding(false)}
              onCreate={async (c) => {
                await saveChannel(c);
                setAdding(false);
              }}
            />
          ) : null}

          {channels.length === 0 && !adding ? (
            <p className="px-1 py-8 text-center text-muted-foreground text-xs">
              <I18nTrans
                components={{ plus: <Plus className="inline size-3" /> }}
                i18nKey="web.ch.empty"
              />
            </p>
          ) : null}

          {channels.map((c) => (
            <ChannelCard
              channel={c}
              key={c.id}
              onRemove={() => removeChannel(c.id)}
              onSave={saveChannel}
              onSetToken={(token) => setToken(c.id, token)}
              onToggle={(enabled) => setEnabled(c, enabled)}
              status={statusById.get(c.id)}
            />
          ))}
        </div>
      </ScrollArea>
    </PanelShell>
  );
}

function StatusDot({ ok, title }: { ok: boolean; title: string }) {
  return (
    <span
      className={cn('inline-block size-2 rounded-full', ok ? 'bg-green-500' : 'bg-muted-foreground/40')}
      title={title}
    />
  );
}

function PairingsPanel({ channelId, t }: { channelId: ChannelId; t: ReturnType<typeof useT> }) {
  const {
    data: pairings = [],
    isFetching,
    refetch
  } = useListChannelPairingsQuery(channelId as ChannelId, {
    pollingInterval: 10_000
  });
  const [approve] = useApproveChannelPairingMutation();
  const [busy, setBusy] = useState<string | null>(null);

  const doApprove = async (code: string) => {
    setBusy(code);
    try {
      await approve({ id: channelId, code }).unwrap();
      void refetch();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-1 rounded-md bg-muted/40 p-2">
      <div className="flex items-center gap-2">
        <span className="font-medium text-xs">{t('web.ch.pairings')}</span>
        <Button
          className="ml-auto size-5"
          onClick={() => void refetch()}
          size="icon"
          variant="ghost"
        >
          <RefreshCw className={cn('size-3', isFetching && 'animate-spin')} />
        </Button>
      </div>
      {pairings.length === 0 ? (
        <p className="text-muted-foreground text-xs">{t('web.ch.noPairings')}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {pairings.map((p) => (
            <li
              className="flex items-center gap-2 text-xs"
              key={p.code}
            >
              <span className="truncate text-muted-foreground">{p.senderDisplay ?? p.userId}</span>
              <code className="rounded bg-muted px-1 font-mono">{p.code}</code>
              <Button
                className="ml-auto h-6 px-2"
                disabled={busy === p.code}
                onClick={() => void doApprove(p.code)}
                size="sm"
                variant="outline"
              >
                {busy === p.code ? <Loader2 className="size-3 animate-spin" /> : <ShieldCheck className="size-3" />}
                {t('web.ch.approve')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ChannelCard({
  channel,
  status,
  onToggle,
  onSave,
  onSetToken,
  onRemove
}: {
  channel: ChannelInstanceView;
  status?: { connected: boolean; hasToken: boolean; activeConversations: number; lastError?: string };
  onToggle: (enabled: boolean) => Promise<void>;
  onSave: (c: ChannelInstanceView) => Promise<void>;
  onSetToken: (token: string) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { busy, run } = useAsyncAction();
  const [token, setTokenInput] = useState('');
  const [policy, setPolicy] = useState<ChannelAccessPolicy>(
    channel.allowlist.policy ?? (channel.allowlist.allowAllUsers ? 'open' : 'allowlist')
  );
  const [allowed, setAllowed] = useState(channel.allowlist.allowedUsers.join(', '));
  const [requireMention, setRequireMention] = useState(channel.groupPolicy?.requireMention ?? true);
  const [agentHint, setAgentHint] = useState(channel.agentHint ?? '');
  const [confirmRemove, setConfirmRemove] = useState(false);

  const saveSettings = () =>
    run(() =>
      onSave({
        ...channel,
        allowlist: {
          policy,
          allowAllUsers: policy === 'open',
          allowedUsers: allowed
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        },
        groupPolicy: { ...channel.groupPolicy, requireMention },
        agentHint: agentHint.trim() || undefined
      })
    );

  return (
    <div className="rounded-md border">
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        {open ? (
          <ChevronDown className="size-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-4 text-muted-foreground" />
        )}
        <Badge
          className="text-[10px]"
          variant="secondary"
        >
          {channel.type}
        </Badge>
        <span className="truncate font-medium text-sm">{channel.label}</span>
        <div className="ml-auto flex items-center gap-2 text-muted-foreground text-xs">
          {status ? (
            <StatusDot
              ok={status.connected}
              title={status.connected ? t('web.ch.connected') : (status.lastError ?? t('web.ch.disconnected'))}
            />
          ) : null}
          {status?.activeConversations ? (
            <span title={t('web.ch.activeConvos')}>
              <I18nTrans
                components={{ count: <span /> }}
                i18nKey="web.ch.chats"
                values={{ count: status.activeConversations }}
              />
            </span>
          ) : null}
          {!status?.hasToken ? (
            <span
              className="text-amber-500"
              title={t('web.ch.noTokenTitle')}
            >
              {t('web.ch.noToken')}
            </span>
          ) : null}
          {!channel.enabled ? <span>{t('web.ch.disabled')}</span> : null}
        </div>
      </button>

      {open ? (
        <div className="flex flex-col gap-3 border-t px-3 py-3">
          <div className="flex items-center gap-2">
            <Button
              disabled={busy}
              onClick={() => run(() => onToggle(!channel.enabled))}
              size="sm"
              variant={channel.enabled ? 'secondary' : 'outline'}
            >
              <Power /> {channel.enabled ? t('web.ch.enabled') : t('web.ch.disabled')}
            </Button>
            <span className="text-muted-foreground text-xs">{channel.id}</span>
          </div>

          {/* bot token */}
          <div className="flex flex-col gap-1">
            <Label className="text-xs">{status?.hasToken ? t('web.ch.botTokenSet') : t('web.ch.botToken')}</Label>
            <div className="flex gap-2">
              <Input
                className="[-webkit-text-security:disc]"
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder={t('web.ch.tokenPlaceholder')}
                value={token}
                {...SECRET_INPUT_PASSWORD_MANAGER_PROPS}
              />
              <Button
                disabled={busy || !token}
                onClick={() =>
                  run(async () => {
                    await onSetToken(token);
                    setTokenInput('');
                  })
                }
                size="sm"
              >
                <KeyRound /> {t('web.save')}
              </Button>
            </div>
          </div>

          {/* access policy */}
          <div className="flex flex-col gap-2">
            <Label className="text-xs">{t('web.ch.policy')}</Label>
            <Select
              onValueChange={(v) => setPolicy(v as ChannelAccessPolicy)}
              value={policy}
            >
              <SelectTrigger className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="allowlist">{t('web.ch.policyAllowlist')}</SelectItem>
                <SelectItem value="pairing">{t('web.ch.policyPairing')}</SelectItem>
                <SelectItem value="open">{t('web.ch.policyOpen')}</SelectItem>
                <SelectItem value="disabled">{t('web.ch.policyDisabled')}</SelectItem>
              </SelectContent>
            </Select>

            {policy === 'allowlist' || policy === 'pairing' ? (
              <Input
                onChange={(e) => setAllowed(e.target.value)}
                placeholder={t('web.ch.allowedPlaceholder')}
                value={allowed}
              />
            ) : null}

            {policy === 'pairing' ? (
              <PairingsPanel
                channelId={channel.id as ChannelId}
                t={t}
              />
            ) : null}

            <label className="flex items-center gap-2 text-muted-foreground text-xs">
              <input
                checked={requireMention}
                onChange={(e) => setRequireMention(e.target.checked)}
                type="checkbox"
              />{' '}
              {t('web.ch.requireMention')}
            </label>
          </div>

          {/* agent hint */}
          <div className="flex flex-col gap-1">
            <Label className="text-xs">{t('web.ch.agentHint')}</Label>
            <Textarea
              onChange={(e) => setAgentHint(e.target.value)}
              placeholder={t('web.ch.agentHintPlaceholder')}
              rows={2}
              value={agentHint}
            />
          </div>

          <Button
            className="self-start"
            disabled={busy}
            onClick={saveSettings}
            size="sm"
            variant="outline"
          >
            <Check /> {t('web.ch.saveSettings')}
          </Button>

          {/* remove */}
          <div className="flex items-center gap-2 border-t pt-2">
            {confirmRemove ? (
              <>
                <span className="text-muted-foreground text-xs">{t('web.ch.confirmRemove')}</span>
                <Button
                  disabled={busy}
                  onClick={() => run(onRemove)}
                  size="sm"
                  variant="destructive"
                >
                  {busy ? <Loader2 className="animate-spin" /> : <Trash2 />} {t('web.ch.remove')}
                </Button>
                <Button
                  onClick={() => setConfirmRemove(false)}
                  size="sm"
                  variant="ghost"
                >
                  {t('web.cancel')}
                </Button>
              </>
            ) : (
              <Button
                onClick={() => setConfirmRemove(true)}
                size="sm"
                variant="ghost"
              >
                <Trash2 /> {t('web.ch.remove')}
              </Button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AddChannelForm({
  onCreate,
  onCancel
}: {
  onCreate: (c: ChannelInstanceView) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useT();
  const [type, setType] = useState('telegram');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      await onCreate({
        id: newId('chn'),
        type,
        label: label.trim() || type,
        enabled: true,
        options: {},
        allowlist: { allowAllUsers: false, allowedUsers: [] },
        mapping: { granularity: 'per-conversation' },
        rateLimitPerMin: 20
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-md border border-primary/30 bg-primary/5 p-3">
      <div className="flex items-center justify-between">
        <span className="font-medium text-sm">{t('web.ch.addTitle')}</span>
        <Button
          className="size-6"
          onClick={onCancel}
          size="icon"
          variant="ghost"
        >
          <X />
        </Button>
      </div>
      <div className="flex gap-2">
        <div className="flex flex-col gap-1">
          <Label className="text-xs">{t('web.ch.type')}</Label>
          <Select
            onValueChange={setType}
            value={type}
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KNOWN_TYPES.map((ct) => (
                <SelectItem
                  key={ct}
                  value={ct}
                >
                  {ct}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-1 flex-col gap-1">
          <Label className="text-xs">{t('web.ch.label')}</Label>
          <Input
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t('web.ch.labelPlaceholder')}
            value={label}
          />
        </div>
      </div>
      <p className="text-muted-foreground text-xs">{t('web.ch.addHint')}</p>
      <Button
        className="self-start"
        disabled={busy}
        onClick={create}
        size="sm"
      >
        {busy ? <Loader2 className="animate-spin" /> : <Plus />} {t('web.ch.create')}
      </Button>
    </div>
  );
}
