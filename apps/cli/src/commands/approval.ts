import type { ApprovalScope, PendingInteraction, PersistedApprovalScope } from '@monad/protocol';
import type { InteractionPromptIO } from '../interactions/presenter.ts';
import type { CommandContext, CommandDef } from './types.ts';

import { pendingInteractionSchema } from '@monad/protocol';
import { z } from 'zod';

import { answerInteraction, interactionProducerLabel } from '../interactions/presenter.ts';
import { t } from '../lib/i18n.ts';
import { bold, cyan, dim, green, json, out, red } from '../lib/output.ts';
import { requireTreatyData } from '../lib/treaty.ts';
import { usageError } from './types.ts';

type Client = CommandContext['client'];

const APPROVAL_SCOPES = ['once', 'session', 'agent', 'global'] as const;

const interactionsResponseSchema = z.object({ interactions: z.array(z.unknown()).optional() });

function flagStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return value ? [String(value)] : [];
}

function scopeFlag(flags: Record<string, unknown>): ApprovalScope | undefined {
  const value = flags.scope;
  if (value === undefined) return undefined;
  if (!(APPROVAL_SCOPES as readonly unknown[]).includes(value)) {
    throw usageError(t('cli.approval.badScope', { list: APPROVAL_SCOPES.join(', ') }));
  }
  return value as ApprovalScope;
}

async function fetchPendingInteractions(client: Client): Promise<PendingInteraction[]> {
  const response = await client.fetch('/v1/interactions');
  if (!response.ok) throw new Error(t('cli.approval.listFailed', { status: response.status }));
  const body = interactionsResponseSchema.parse(await response.json());
  return (body.interactions ?? []).map((item) => pendingInteractionSchema.parse(item));
}

/** Everything currently blocked on a human: high-risk tool calls held at the oversight gate, plus
 *  host interactions waiting for a presenter. Headless callers poll this between turns. */
async function listPending(client: Client, flags: Record<string, unknown>): Promise<void> {
  const sessionId = typeof flags.session === 'string' && flags.session ? flags.session : undefined;
  const [tools, interactions] = await Promise.all([
    client.treaty.v1.approvals.pending.get({ query: { sessionId } }).then(requireTreatyData),
    fetchPendingInteractions(client)
  ]);
  json({ tools: tools.pending, interactions });
  if (tools.pending.length === 0 && interactions.length === 0) {
    out(dim(t('cli.empty.pendingApprovals')));
    return;
  }
  for (const call of tools.pending) {
    out(cyan(call.requestId) + dim('  tool  ') + bold(call.tool) + dim(`  ${call.sessionId}`));
  }
  for (const interaction of interactions) {
    out(
      cyan(interaction.id) +
        dim(`  ${interaction.request.type}  `) +
        bold(interaction.request.title) +
        dim(`  ${interactionProducerLabel(interaction.source)}`)
    );
  }
}

/** Resolve one tool call the agent loop is blocked on. `requestId` comes from the
 *  `tool.approval_requested` event (`monad session watch`) or a mesh runtime listing. */
async function resolveToolCall(
  client: Client,
  requestId: string | undefined,
  allow: boolean,
  flags: Record<string, unknown>
): Promise<void> {
  if (!requestId) throw usageError('usage: monad approval allow|deny <requestId> [--scope <s>] [--reason <text>]');
  const reason = typeof flags.reason === 'string' && flags.reason ? flags.reason : undefined;
  const { ok } = requireTreatyData(
    await client.treaty.v1.tools.approve.post({
      requestId,
      allow,
      ...(reason ? { reason } : {}),
      scope: scopeFlag(flags)
    })
  );
  json({ ok, requestId, allow });
  out((allow ? green(t('cli.approval.allowed')) : red(t('cli.approval.denied'))) + dim(`  ${requestId}`));
}

/** Non-interactive prompt IO: every field is answered from repeated `--value key=value` flags, so a
 *  form interaction can be satisfied without a TTY. Missing keys are a usage error, not a hang. */
function flagIO(pairs: string[]): InteractionPromptIO {
  const values = new Map(
    pairs.map((pair) => {
      const index = pair.indexOf('=');
      if (index <= 0) throw usageError(t('cli.approval.badValue', { pair }));
      return [pair.slice(0, index), pair.slice(index + 1)] as const;
    })
  );
  const take = (label: string): string => {
    const value = values.get(label);
    if (value === undefined) throw usageError(t('cli.approval.missingValue', { label }));
    return value;
  };
  return {
    text: (label) => Promise.resolve(take(label)),
    secret: (label) => Promise.resolve(take(label)),
    confirm: (label) => Promise.resolve(/^(1|y|yes|true)$/i.test(take(label))),
    select: (label) => Promise.resolve(take(label))
  };
}

async function answer(client: Client, id: string | undefined, flags: Record<string, unknown>): Promise<void> {
  if (!id) throw usageError('usage: monad approval answer <interactionId> [--value key=value ...]');
  const interaction = (await fetchPendingInteractions(client)).find((item) => item.id === id);
  if (!interaction) throw new Error(t('cli.approval.interactionNotFound', { id }));
  const pairs = flagStrings(flags.value);
  out(
    `${t('cli.approval.requestedBy', { by: interactionProducerLabel(interaction.source) })}\n${interaction.request.title}`
  );
  await answerInteraction(
    client,
    interaction,
    `cli-answer-${crypto.randomUUID()}`,
    pairs.length ? flagIO(pairs) : undefined
  );
  json({ ok: true, interactionId: id });
}

async function listRules(client: Client): Promise<void> {
  const { rules } = requireTreatyData(await client.treaty.v1.approvals.get({ query: { sessionId: undefined } }));
  json(rules);
  if (rules.length === 0) {
    out(dim(t('cli.empty.approvals')));
    return;
  }
  for (const rule of rules) {
    const decision = rule.decision === 'deny' ? red(rule.decision) : green(rule.decision);
    const target = rule.key ? `${rule.tool}(${rule.key})` : rule.tool;
    const where = rule.scope === 'agent' ? `agent:${rule.agentId ?? '?'}` : rule.scope;
    out(cyan(rule.id) + dim('  ') + decision + dim('  ') + bold(target) + dim(`  ${where}  ${rule.source}`));
  }
}

async function revoke(client: Client, id: string | undefined): Promise<void> {
  if (!id) throw usageError('usage: monad approval revoke <ruleId>');
  const { ok } = requireTreatyData(await client.treaty.v1.approvals.revoke.post({ id }));
  json({ ok, id });
  out((ok ? green(t('cli.deleted')) : red(t('cli.failed'))) + dim(`  ${id}`));
}

async function clear(client: Client, flags: Record<string, unknown>): Promise<void> {
  const scope = flags.scope as PersistedApprovalScope | undefined;
  const agentId = typeof flags.agent === 'string' ? flags.agent : undefined;
  const { removed } = requireTreatyData(await client.treaty.v1.approvals.clear.post({ scope, agentId }));
  json({ removed: removed ?? 0 });
  out(green(t('cli.deleted')) + dim(`  ${removed ?? 0}`));
}

// One noun for every point where an agent is blocked on a human: the pending queue (`list`),
// answering it (`allow`/`deny` for tool calls, `answer` for host interactions), and the remembered
// rules that stop it recurring (`rules`/`revoke`/`clear`).
export const command: CommandDef = {
  name: 'approval',
  group: 'work',
  aliases: ['approvals'],
  synopsis: 'approval <list|allow|deny|answer|rules|revoke|clear> [id]',
  subcommands: ['list', 'allow', 'deny', 'answer', 'rules', 'revoke', 'clear'],
  description: 'answer what the agent is waiting on, and manage remembered approval rules',
  descriptionKey: 'cli.cmd.approval.desc',
  flags: {
    scope: {
      type: 'string',
      description: 'approval scope: once | session | agent | global',
      descriptionKey: 'cli.approval.flag.scope'
    },
    reason: {
      type: 'string',
      description: 'reason recorded with the decision',
      descriptionKey: 'cli.approval.flag.reason'
    },
    agent: { type: 'string', description: 'agent id filter for clear', descriptionKey: 'cli.approval.flag.agent' },
    session: {
      type: 'string',
      description: 'session id filter for list',
      descriptionKey: 'cli.approval.flag.session'
    },
    value: {
      type: 'string',
      description: 'answer one interaction field as key=value; repeat per field',
      descriptionKey: 'cli.approval.flag.value'
    }
  },
  async run({ positionals, flags, client }) {
    const [action = 'list', id] = positionals;
    switch (action) {
      case 'list':
      case 'ls':
        return listPending(client, flags);
      case 'allow':
        return resolveToolCall(client, id, true, flags);
      case 'deny':
        return resolveToolCall(client, id, false, flags);
      case 'answer':
        return answer(client, id, flags);
      case 'rules':
        return listRules(client);
      case 'revoke':
        return revoke(client, id);
      case 'clear':
        return clear(client, flags);
      default:
        throw usageError(t('cli.approval.unknownAction', { action }));
    }
  }
};
