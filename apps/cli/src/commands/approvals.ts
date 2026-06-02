import type { PersistedApprovalScope } from '@monad/protocol';

import { t } from '../lib/i18n.ts';
import { bold, cyan, dim, green, json, out, red } from '../lib/output.ts';
import { requireTreatyData } from '../lib/treaty.ts';
import { type CommandDef, usageError } from './types.ts';

// Manage remembered approval rules (allow/deny across session/agent/global scopes). Backed by the
// daemon's /v1/approvals endpoints; secrets/policy stay daemon-side. noun-verb like `git remote`.
export const command: CommandDef = {
  name: 'approvals',
  aliases: ['approval'],
  synopsis: 'approvals <list|revoke <id>|clear [--scope <s>] [--agent <id>]>',
  description: 'manage remembered tool-approval rules (list, revoke, clear)',
  descriptionKey: 'cli.cmd.approvals.desc',
  flags: {
    scope: { type: 'string', description: 'filter for clear: session|agent|global' },
    agent: { type: 'string', description: 'filter for clear: agent id' }
  },
  async run({ positionals: args, flags, client }) {
    const [action = 'list', arg] = args;

    if (action === 'list') {
      const { rules } = requireTreatyData(await client.treaty.v1.approvals.get({ query: { sessionId: undefined } }));
      json(rules);
      if (rules.length === 0) {
        out(dim(t('cli.empty.approvals')));
        return;
      }
      for (const r of rules) {
        const decision = r.decision === 'deny' ? red(r.decision) : green(r.decision);
        const target = r.key ? `${r.tool}(${r.key})` : r.tool;
        const where = r.scope === 'agent' ? `agent:${r.agentId ?? '?'}` : r.scope;
        out(cyan(r.id) + dim('  ') + decision + dim('  ') + bold(target) + dim(`  ${where}  ${r.source}`));
      }
      return;
    }

    if (action === 'revoke') {
      if (!arg) throw usageError('usage: monad approvals revoke <id>');
      const { ok } = requireTreatyData(await client.treaty.v1.approvals.revoke.post({ id: arg }));
      out(ok ? green(t('cli.deleted')) + dim(`  ${arg}`) : red(t('cli.failed')) + dim(`  ${arg}`));
      return;
    }

    if (action === 'clear') {
      const scope = flags.scope as PersistedApprovalScope | undefined;
      const agentId = flags.agent as string | undefined;
      const { removed } = requireTreatyData(await client.treaty.v1.approvals.clear.post({ scope, agentId }));
      out(green(t('cli.deleted')) + dim(`  ${removed ?? 0}`));
      return;
    }

    throw new Error(t('cli.approvals.unknownAction', { action: String(action) }));
  }
};
