import type { MonadClient } from '@monad/client';
import type {
  InteractionEvent,
  InteractionPresenterCapabilities,
  InteractionSource,
  PendingInteraction
} from '@monad/protocol';

import { createInterface } from 'node:readline';
import { z } from 'zod';

export interface InteractionPromptIO {
  text(label: string): Promise<string>;
  secret(label: string): Promise<string>;
  confirm(label: string): Promise<boolean>;
  select(label: string, options: Array<{ value: string; label: string }>): Promise<string>;
}

export function interactionSourceLabel(source: InteractionSource): string {
  return source.kind === 'builtin' ? (source.label ?? source.id) : `${source.packId} · ${source.atomId}`;
}

export function interactionRequiredJson(interaction: PendingInteraction) {
  return {
    status: 'interaction_required' as const,
    interactionId: interaction.id,
    source: interaction.source,
    title: interaction.request.title
  };
}

export async function collectInteractionValues(
  interaction: PendingInteraction,
  io: InteractionPromptIO
): Promise<Record<string, unknown>> {
  const { request } = interaction;
  if (request.type === 'confirm') return { confirmed: await io.confirm(request.confirmLabel ?? request.title) };
  if (request.type === 'select') return { value: await io.select(request.title, request.options) };

  const values: Record<string, unknown> = {};
  for (const field of request.fields) {
    switch (field.type) {
      case 'string':
        values[field.id] = (await io.text(field.label)) || field.defaultValue || '';
        break;
      case 'secret':
        values[field.id] = await io.secret(field.label);
        break;
      case 'number': {
        const raw = await io.text(field.label);
        values[field.id] = raw === '' ? field.defaultValue : Number(raw);
        break;
      }
      case 'boolean':
        values[field.id] = await io.confirm(field.label);
        break;
      case 'select':
        values[field.id] = await io.select(field.label, field.options);
        break;
    }
  }
  return values;
}

function question(label: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(`${label}: `, (answer) => {
      rl.close();
      resolve(answer.trim());
    })
  );
}

function hiddenQuestion(label: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    return Promise.reject(new Error('safe secret input requires an interactive TTY'));
  }
  process.stdout.write(`${label}: `);
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write('\n');
    };
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) {
          cleanup();
          reject(new Error('cancelled'));
          return;
        }
        if (byte === 13 || byte === 10) {
          cleanup();
          resolve(value);
          return;
        }
        if (byte === 8 || byte === 127) value = value.slice(0, -1);
        else if (byte >= 32) value += String.fromCharCode(byte);
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

const terminalInteractionIO: InteractionPromptIO = {
  text: question,
  secret: hiddenQuestion,
  async confirm(label) {
    const answer = (await question(`${label} [y/N]`)).toLowerCase();
    return answer === 'y' || answer === 'yes';
  },
  async select(label, options) {
    process.stdout.write(`${label}\n${options.map((option, index) => `  ${index + 1}. ${option.label}`).join('\n')}\n`);
    const picked = Number(await question('Select')) - 1;
    return options[picked]?.value ?? options[0]?.value ?? '';
  }
};

const CLI_CAPABILITIES: InteractionPresenterCapabilities = {
  interactionTypes: ['confirm', 'select', 'form'],
  fieldTypes: ['string', 'secret', 'number', 'boolean', 'select'],
  supportsSecretInput: true,
  supportsBackgroundQueue: true
};

export async function answerInteraction(
  client: MonadClient,
  interaction: PendingInteraction,
  presenterId: string,
  io: InteractionPromptIO = terminalInteractionIO
): Promise<void> {
  const claim = await client.fetch(`/v1/interactions/${encodeURIComponent(interaction.id)}/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ presenterId, capabilities: CLI_CAPABILITIES })
  });
  if (!claim.ok) throw new Error(`failed to claim interaction (${claim.status})`);
  const { leaseToken } = z.object({ leaseToken: z.string().min(1) }).parse(await claim.json());
  const renewTimer = setInterval(
    () =>
      void client.fetch(`/v1/interactions/${encodeURIComponent(interaction.id)}/renew`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ leaseToken })
      }),
    10_000
  );
  renewTimer.unref?.();
  try {
    const values = await collectInteractionValues(interaction, io);
    const submitted = await client.fetch(`/v1/interactions/${encodeURIComponent(interaction.id)}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ leaseToken, values })
    });
    if (!submitted.ok) throw new Error(`failed to submit interaction (${submitted.status})`);
  } catch (error) {
    await client.fetch(`/v1/interactions/${encodeURIComponent(interaction.id)}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ leaseToken, reason: 'escape' })
    });
    throw error;
  } finally {
    clearInterval(renewTimer);
  }
}

export function startCliInteractionPresenter(
  client: MonadClient,
  options: {
    io?: InteractionPromptIO;
    onPresent?: (interaction: PendingInteraction) => void;
    onError?: (error: unknown) => void;
  } = {}
): () => Promise<void> {
  const presenterId = `cli-${crypto.randomUUID()}`;
  let stopped = false;
  let busy = false;
  const pending = new Map<string, PendingInteraction>();
  const drain = () => {
    if (stopped || busy) return;
    const next = [...pending.values()].find((item) => item.mode === 'foreground' && item.state === 'pending');
    if (!next) return;
    pending.delete(next.id);
    void present(next);
  };
  const present = async (interaction: PendingInteraction) => {
    if (stopped || busy || interaction.mode !== 'foreground' || interaction.state !== 'pending') return;
    try {
      busy = true;
      options.onPresent?.(interaction);
      await answerInteraction(client, interaction, presenterId, options.io);
    } catch (error) {
      options.onError?.(error);
    } finally {
      busy = false;
      drain();
    }
  };
  const onEvent = (event: InteractionEvent) => {
    if (event.type === 'removed') {
      pending.delete(event.id);
      return;
    }
    pending.set(event.interaction.id, event.interaction);
    drain();
  };
  const dispose = client.streamInteractionEvents(onEvent, { onError: options.onError });
  return async () => {
    stopped = true;
    dispose();
    await client.fetch(`/v1/interactions/presenters/${encodeURIComponent(presenterId)}/release`, { method: 'POST' });
  };
}
