import type { PendingInteraction } from '@monad/protocol';
import type { CommandDef } from './types.ts';

import { pendingInteractionSchema } from '@monad/protocol';
import { z } from 'zod';

const interactionsResponseSchema = z.object({ interactions: z.array(z.unknown()).optional() });

import { answerInteraction, interactionRequiredJson, interactionSourceLabel } from '../interactions/presenter.ts';
import { out } from '../lib/output.ts';
import { usageError } from './types.ts';

export const command: CommandDef = {
  name: 'interaction',
  synopsis: 'interaction answer <id>',
  description: 'Answer a pending host interaction',
  async run({ client, positionals, globals }) {
    const [action, id] = positionals;
    if (action !== 'answer' || !id) throw usageError('usage: monad interaction answer <id>');
    const response = await client.fetch('/v1/interactions');
    if (!response.ok) throw new Error(`failed to list interactions (${response.status})`);
    const body = interactionsResponseSchema.parse(await response.json());
    const interaction = (body.interactions ?? [])
      .map((item) => pendingInteractionSchema.parse(item))
      .find((item): item is PendingInteraction => item.id === id);
    if (!interaction) throw new Error(`interaction not found: ${id}`);

    if (globals.json || !process.stdin.isTTY || !process.stdout.isTTY) {
      out(JSON.stringify(interactionRequiredJson(interaction)));
      return;
    }
    out(`Requested by ${interactionSourceLabel(interaction.source)}\n${interaction.request.title}`);
    await answerInteraction(client, interaction, `cli-answer-${crypto.randomUUID()}`);
  }
};
