import type { StrictTranslateForNamespace } from '@monad/i18n';
import type { ChannelInbound, ChannelPairingRequest } from '@monad/protocol';
import type { ChannelLogger, Instance } from '#/channels/channel.ts';

import { makePairingCode } from '#/channels/helpers.ts';

const PAIRING_TTL_MS = 15 * 60_000;

interface PendingPairing {
  code: string;
  userId: string;
  senderDisplay?: string;
  requestedAt: number;
  expiresAt: number;
}

export class ChannelPairings {
  private readonly pendingPairings = new Map<string, Map<string, PendingPairing>>();

  constructor(
    private readonly log: ChannelLogger,
    private readonly t: StrictTranslateForNamespace<'channel'>
  ) {}

  async issue(inst: Instance, m: ChannelInbound): Promise<void> {
    const channelId = inst.config.id;
    let perChannel = this.pendingPairings.get(channelId);
    if (!perChannel) {
      perChannel = new Map();
      this.pendingPairings.set(channelId, perChannel);
    }
    const now = Date.now();
    let pending = perChannel.get(m.userId);
    if (!pending || pending.expiresAt <= now) {
      pending = {
        code: makePairingCode(),
        userId: m.userId,
        senderDisplay: m.senderDisplay,
        requestedAt: now,
        expiresAt: now + PAIRING_TTL_MS
      };
      perChannel.set(m.userId, pending);
      this.log.info(`channel "${channelId}": pairing requested by user ${m.userId}`);
    }
    await inst.adapter?.send(m.chatId, this.t('channel.pairing.requested', { code: pending.code })).catch(() => {});
  }

  list(channelId: string): ChannelPairingRequest[] {
    const perChannel = this.pendingPairings.get(channelId);
    if (!perChannel) return [];
    const now = Date.now();
    const out: ChannelPairingRequest[] = [];
    for (const p of perChannel.values()) {
      if (p.expiresAt <= now) continue;
      out.push({
        channelId: channelId as ChannelPairingRequest['channelId'],
        code: p.code,
        userId: p.userId,
        senderDisplay: p.senderDisplay,
        requestedAt: new Date(p.requestedAt).toISOString(),
        expiresAt: new Date(p.expiresAt).toISOString()
      });
    }
    return out;
  }

  consume(channelId: string, code: string): string | null {
    const perChannel = this.pendingPairings.get(channelId);
    if (!perChannel) return null;
    const now = Date.now();
    const want = code.trim().toUpperCase();
    for (const [userId, p] of perChannel) {
      if (p.expiresAt <= now) {
        perChannel.delete(userId);
        continue;
      }
      if (p.code === want) {
        perChannel.delete(userId);
        return userId;
      }
    }
    return null;
  }
}
