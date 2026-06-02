import type { PendingInteraction } from '@monad/protocol';

import { expect, test } from 'bun:test';

import {
  collectInteractionValues,
  interactionRequiredJson,
  startCliInteractionPresenter
} from '../../src/interactions/presenter.ts';

const interaction: PendingInteraction = {
  id: 'interaction-1',
  source: { kind: 'atom-pack', packId: 'vendor.pack', atomId: 'cloud' },
  request: {
    type: 'form',
    title: 'Configure',
    fields: [
      { id: 'name', type: 'string', label: 'Name' },
      { id: 'apiKey', type: 'secret', label: 'API key' },
      { id: 'count', type: 'number', label: 'Count' },
      { id: 'enabled', type: 'boolean', label: 'Enabled' },
      { id: 'region', type: 'select', label: 'Region', options: [{ value: 'us', label: 'US' }] }
    ]
  },
  mode: 'background',
  state: 'pending',
  createdAt: '2026-07-13T00:00:00.000Z',
  expiresAt: '2026-07-13T00:05:00.000Z'
};

test('collects all field types and routes secrets through the no-echo method', async () => {
  const calls: string[] = [];
  const values = await collectInteractionValues(interaction, {
    text: async (label) => {
      calls.push(`text:${label}`);
      return label === 'Name' ? 'demo' : '2';
    },
    secret: async (label) => {
      calls.push(`secret:${label}`);
      return 'secret-value';
    },
    confirm: async (label) => {
      calls.push(`confirm:${label}`);
      return true;
    },
    select: async (label, options) => {
      calls.push(`select:${label}:${options.length}`);
      return options[0]?.value ?? '';
    }
  });

  expect(values).toEqual({ name: 'demo', apiKey: 'secret-value', count: 2, enabled: true, region: 'us' });
  expect(calls).toContain('secret:API key');
  expect(calls).not.toContain('text:API key');
});

test('non-interactive output contains only the resumable id and trusted attribution', () => {
  const output = interactionRequiredJson(interaction);

  expect(output).toEqual({
    status: 'interaction_required',
    interactionId: 'interaction-1',
    source: { kind: 'atom-pack', packId: 'vendor.pack', atomId: 'cloud' },
    title: 'Configure'
  });
  expect(JSON.stringify(output)).not.toContain('secret-value');
});

test('event presenter drains pending interactions that arrive while busy', async () => {
  let eventHandler: ((event: { type: 'upsert'; interaction: PendingInteraction }) => void) | undefined;
  const fetches: string[] = [];
  let releaseFirstAnswer: (() => void) | undefined;
  const presented: string[] = [];

  const first: PendingInteraction = {
    ...interaction,
    id: 'interaction-first',
    mode: 'foreground',
    request: { type: 'confirm', title: 'First?' }
  };
  const second: PendingInteraction = {
    ...interaction,
    id: 'interaction-second',
    mode: 'foreground',
    request: { type: 'confirm', title: 'Second?' }
  };
  const client = {
    streamInteractionEvents(handler: typeof eventHandler) {
      eventHandler = handler;
      return () => {};
    },
    fetch: async (path: string) => {
      fetches.push(path);
      if (path.endsWith('/claim')) return Response.json({ leaseToken: `lease-${fetches.length}` });
      return Response.json({ ok: true });
    }
  };

  const stop = startCliInteractionPresenter(client as never, {
    onPresent: (item) => presented.push(item.id),
    io: {
      text: async () => '',
      secret: async () => '',
      select: async (_label, options) => options[0]?.value ?? '',
      confirm: async (label) => {
        if (label === 'First?') await new Promise<void>((resolve) => (releaseFirstAnswer = resolve));
        return true;
      }
    }
  });

  eventHandler?.({ type: 'upsert', interaction: first });
  eventHandler?.({ type: 'upsert', interaction: second });
  for (let i = 0; i < 10 && !releaseFirstAnswer; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  expect(presented).toEqual(['interaction-first']);
  releaseFirstAnswer?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(presented).toEqual(['interaction-first', 'interaction-second']);
  await stop();
});
