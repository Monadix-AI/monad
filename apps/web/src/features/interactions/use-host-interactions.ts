import type { InteractionPresenterCapabilities, PendingInteraction } from '@monad/protocol';

import { pendingInteractionSchema } from '@monad/protocol';
import { useEffect, useRef, useState } from 'react';

import { useMonadRuntime } from '#/lib/monad-runtime-provider';

const WEB_CAPABILITIES: InteractionPresenterCapabilities = {
  interactionTypes: ['confirm', 'select', 'form'],
  fieldTypes: ['string', 'secret', 'number', 'boolean', 'select'],
  supportsSecretInput: true,
  supportsBackgroundQueue: true
};

export interface ClaimedHostInteraction {
  interaction: PendingInteraction;
  leaseToken: string;
}

type CancellationReason = 'close' | 'escape' | 'timeout' | 'disconnect' | 'unavailable';

export function useHostInteractions() {
  const { client } = useMonadRuntime();
  const presenterId = useRef(`web-${crypto.randomUUID()}`);
  const activeRef = useRef<ClaimedHostInteraction | null>(null);
  const claimingRef = useRef(false);
  const [active, setActive] = useState<ClaimedHostInteraction | null>(null);
  const [backgroundCount, setBackgroundCount] = useState(0);

  useEffect(() => {
    let disposed = false;
    const poll = async () => {
      try {
        const response = await client.fetch('/v1/interactions');
        if (!response.ok || disposed) return;
        const body = (await response.json()) as { interactions?: unknown[] };
        const interactions = (body.interactions ?? []).map((item) => pendingInteractionSchema.parse(item));
        setBackgroundCount(interactions.filter((item) => item.mode === 'background').length);
        if (activeRef.current || claimingRef.current) return;
        const candidate = interactions.find((item) => item.mode === 'foreground' && item.state === 'pending');
        if (!candidate) return;

        claimingRef.current = true;
        const claimed = await client.fetch(`/v1/interactions/${encodeURIComponent(candidate.id)}/claim`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ presenterId: presenterId.current, capabilities: WEB_CAPABILITIES })
        });
        if (!claimed.ok || disposed) return;
        const value = (await claimed.json()) as ClaimedHostInteraction;
        activeRef.current = value;
        setActive(value);
      } catch {
        // A disconnected daemon is reflected elsewhere in the shell; presenter polling stays quiet.
      } finally {
        claimingRef.current = false;
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), 750);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      void client.fetch(`/v1/interactions/presenters/${encodeURIComponent(presenterId.current)}/release`, {
        method: 'POST'
      });
    };
  }, [client]);

  useEffect(() => {
    if (!active) return;
    const renew = () =>
      client.fetch(`/v1/interactions/${encodeURIComponent(active.interaction.id)}/renew`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ leaseToken: active.leaseToken })
      });
    const timer = window.setInterval(() => void renew(), 10_000);
    return () => window.clearInterval(timer);
  }, [active, client]);

  const complete = async (action: 'submit' | 'cancel', body: Record<string, unknown>): Promise<void> => {
    const current = activeRef.current;
    if (!current) return;
    const response = await client.fetch(`/v1/interactions/${encodeURIComponent(current.interaction.id)}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ leaseToken: current.leaseToken, ...body })
    });
    if (!response.ok) throw new Error(`interaction ${action} failed (${response.status})`);
    activeRef.current = null;
    setActive(null);
  };

  return {
    active,
    backgroundCount,
    submit: (values: Record<string, unknown>) => complete('submit', { values }),
    cancel: (reason: CancellationReason) => complete('cancel', { reason })
  };
}
