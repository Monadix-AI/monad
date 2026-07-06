// The pairing HTTP handlers: approving a code consumes it from the ChannelService and appends the
// awaiting user to the channel's allowlist, then commits. Drives the handler against fakes so the
// wiring (consume → append → commit) is locked without standing up a full daemon.

import type { ChannelSettingsContext } from '@/handlers/settings/channel/context.ts';

import { expect, test } from 'bun:test';

import { createPairingHandlers } from '@/handlers/settings/channel/handlers/pairing.ts';

function fakeCtx(opts: {
  consume: (id: string, code: string) => string | null;
  channel?: { id: string; allowlist: { allowedUsers: string[] } };
}) {
  const committed: unknown[] = [];
  const cfg = {
    channels: opts.channel ? [opts.channel] : []
  };
  const ctx = {
    read: async () => ({ cfg, auth: {} }),
    commit: async (next: unknown) => {
      committed.push(next);
    },
    service: {
      consumePairing: opts.consume,
      listPendingPairings: () => []
    }
  } as unknown as ChannelSettingsContext;
  return { ctx, committed, cfg };
}

test('approveChannelPairing: valid code → user appended to allowlist + committed', async () => {
  const { ctx, committed } = fakeCtx({
    consume: () => 'newcomer',
    channel: { id: 'chn_X', allowlist: { allowedUsers: [] } }
  });
  const res = await createPairingHandlers(ctx).approveChannelPairing({ id: 'chn_X', code: 'ABC123' });
  expect(res.ok).toBe(true);
  expect(committed.length).toBe(1);
  const next = committed[0] as { channels: Array<{ id: string; allowlist: { allowedUsers: string[] } }> };
  expect(next.channels[0]?.allowlist.allowedUsers).toEqual(['newcomer']);
});

test('approveChannelPairing: invalid/expired code throws, nothing committed', async () => {
  const { ctx, committed } = fakeCtx({
    consume: () => null,
    channel: { id: 'chn_X', allowlist: { allowedUsers: [] } }
  });
  await expect(createPairingHandlers(ctx).approveChannelPairing({ id: 'chn_X', code: 'BAD' })).rejects.toThrow();
});

test('approveChannelPairing: already-allowlisted user is a no-op commit', async () => {
  const { ctx, committed } = fakeCtx({
    consume: () => 'existing',
    channel: { id: 'chn_X', allowlist: { allowedUsers: ['existing'] } }
  });
  const res = await createPairingHandlers(ctx).approveChannelPairing({ id: 'chn_X', code: 'ABC123' });
  expect(res.ok).toBe(true);
});

test('approveChannelPairing: unknown channel id throws', async () => {
  const { ctx } = fakeCtx({ consume: () => 'newcomer' }); // no channel in cfg
  await expect(
    createPairingHandlers(ctx).approveChannelPairing({ id: 'chn_MISSING', code: 'ABC123' })
  ).rejects.toThrow();
});
