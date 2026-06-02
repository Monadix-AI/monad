import type { InteractionEvent, InteractionPresenterCapabilities, PendingInteraction } from '@monad/protocol';

import { pendingInteractionSchema } from '@monad/protocol';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';

import { useMonadRuntime } from '#/lib/monad-runtime-context';

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

const claimedHostInteractionSchema = z.object({ interaction: pendingInteractionSchema, leaseToken: z.string().min(1) });

type CancellationReason = 'close' | 'escape' | 'timeout' | 'disconnect' | 'unavailable';

export function useHostInteractions() {
  const { client } = useMonadRuntime();
  const presenterId = useRef(`web-${crypto.randomUUID()}`);
  const activeRef = useRef<ClaimedHostInteraction | null>(null);
  const claimingRef = useRef(false);
  const pendingRef = useRef(new Map<string, PendingInteraction>());
  const drainRef = useRef<() => void>(() => {});
  const [active, setActive] = useState<ClaimedHostInteraction | null>(null);
  const [backgroundCount, setBackgroundCount] = useState(0);

  useEffect(() => {
    let disposed = false;
    const refreshBackgroundCount = () => {
      setBackgroundCount([...pendingRef.current.values()].filter((item) => item.mode === 'background').length);
    };
    const drain = () => {
      if (disposed || activeRef.current || claimingRef.current) return;
      const candidate = [...pendingRef.current.values()].find(
        (item) => item.mode === 'foreground' && item.state === 'pending'
      );
      if (!candidate) return;
      pendingRef.current.delete(candidate.id);
      refreshBackgroundCount();
      void claim(candidate);
    };
    const claim = async (candidate: PendingInteraction) => {
      if (activeRef.current || claimingRef.current || candidate.mode !== 'foreground' || candidate.state !== 'pending')
        return;
      try {
        claimingRef.current = true;
        const claimed = await client.fetch(`/v1/interactions/${encodeURIComponent(candidate.id)}/claim`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ presenterId: presenterId.current, capabilities: WEB_CAPABILITIES })
        });
        if (!claimed.ok || disposed) return;
        const value = claimedHostInteractionSchema.parse(await claimed.json());
        activeRef.current = value;
        setActive(value);
      } catch {
        // A disconnected daemon is reflected elsewhere in the shell; presenter polling stays quiet.
      } finally {
        claimingRef.current = false;
        drain();
      }
    };
    drainRef.current = drain;
    const onEvent = (event: InteractionEvent) => {
      if (event.type === 'removed') {
        pendingRef.current.delete(event.id);
        if (activeRef.current?.interaction.id === event.id) {
          activeRef.current = null;
          setActive(null);
          drain();
        }
        refreshBackgroundCount();
        return;
      }
      pendingRef.current.set(event.interaction.id, event.interaction);
      refreshBackgroundCount();
      drain();
    };

    const dispose = client.streamInteractionEvents(onEvent);
    return () => {
      disposed = true;
      drainRef.current = () => {};
      dispose();
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
    drainRef.current();
  };

  return {
    active,
    backgroundCount,
    submit: (values: Record<string, unknown>) => complete('submit', { values }),
    cancel: (reason: CancellationReason) => complete('cancel', { reason })
  };
}
