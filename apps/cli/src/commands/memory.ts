import type { MemoryScopeQuery, OptionalMemoryScopeQuery } from '@monad/protocol';
import type { CommandContext, CommandDef } from './types.ts';

import { memoryScopeQuerySchema, optionalMemoryScopeQuerySchema } from '@monad/protocol';

import { t } from '../lib/i18n.ts';
import { bold, cyan, dim, json, out, red, yellow } from '../lib/output.ts';
import { renderTable } from '../lib/table.ts';
import { requireTreatyData } from '../lib/treaty.ts';
import { usageError } from './types.ts';

type Client = CommandContext['client'];

const SCOPE_KINDS = ['session', 'agent', 'project', 'global'] as const;

/** `--scope <kind>:<id>` (e.g. `agent:agt_x`, or `global:*`). Parsed through the protocol schema so
 *  a malformed scope fails here with the wire contract's own rules, not at the daemon. */
function scopeQuery(flags: Record<string, unknown>): OptionalMemoryScopeQuery {
  const raw = flags.scope;
  if (typeof raw !== 'string' || !raw) return {};
  const index = raw.indexOf(':');
  const parsed = optionalMemoryScopeQuerySchema.safeParse({
    scopeKind: index < 0 ? raw : raw.slice(0, index),
    scopeId: index < 0 ? '*' : raw.slice(index + 1)
  });
  if (!parsed.success) throw usageError(t('cli.memory.badScope', { list: SCOPE_KINDS.join(', ') }));
  return parsed.data;
}

/** The fact list is scope-mandatory (unlike graph/laws, which default to every scope). */
function requiredScope(flags: Record<string, unknown>): MemoryScopeQuery {
  const parsed = memoryScopeQuerySchema.safeParse(scopeQuery(flags));
  if (!parsed.success) throw usageError('usage: monad memory facts --scope <kind>:<id>');
  return parsed.data;
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

async function facts(client: Client, flags: Record<string, unknown>): Promise<void> {
  const scope = requiredScope(flags);
  const { facts: rows } = requireTreatyData(
    await client.treaty.v1.memory.facts.get({ query: { ...scope, limit: undefined, before: undefined } })
  );
  json(rows);
  if (rows.length === 0) {
    out(dim(t('cli.empty.memoryFacts')));
    return;
  }
  for (const fact of rows) {
    const confidence = fact.confidence === undefined ? '' : dim(`  ${pct(fact.confidence)}`);
    out(cyan(fact.id.slice(0, 12)) + dim(`  ${fact.provClass}  `) + fact.content + confidence);
  }
}

/** Inferred L3 laws. A law that is stale or contradicted is suppressed from recall — flag both so
 *  the operator can see why a memory the agent "should" have is not being applied. */
async function laws(client: Client, flags: Record<string, unknown>): Promise<void> {
  const { laws: rows } = requireTreatyData(await client.treaty.v1.memory.laws.get({ query: scopeQuery(flags) }));
  json(rows);
  if (rows.length === 0) {
    out(dim(t('cli.empty.memoryLaws')));
    return;
  }
  for (const law of rows) {
    const flag = law.contradictedBy
      ? red(t('cli.memory.contradicted'))
      : law.stale
        ? yellow(t('cli.memory.stale'))
        : '';
    out(cyan(law.id.slice(0, 12)) + dim(`  ${law.scope}  ${pct(law.effectiveConfidence)}  `) + law.statement + flag);
    if (law.contradictedBy) out(dim(`    ${t('cli.memory.contradictedBy', { text: law.contradictedBy })}`));
  }
}

async function graph(client: Client, flags: Record<string, unknown>): Promise<void> {
  const { nodes, edges } = requireTreatyData(await client.treaty.v1.graph.get({ query: scopeQuery(flags) }));
  json({ nodes, edges });
  if (nodes.length === 0 && edges.length === 0) {
    out(dim(t('cli.empty.memoryGraph')));
    return;
  }
  const nameOf = new Map(nodes.map((node) => [node.id, node.name]));
  out(
    renderTable(
      [t('cli.memory.col.from'), t('cli.memory.col.relation'), t('cli.memory.col.to'), t('cli.memory.col.confidence')],
      edges.map((edge) => [
        nameOf.get(edge.src) ?? edge.src,
        edge.relation,
        nameOf.get(edge.dst) ?? edge.dst,
        pct(edge.confidence)
      ])
    )
  );
  out(dim(t('cli.memory.nodeCount', { count: nodes.length })));
}

async function status(client: Client): Promise<void> {
  const snapshot = requireTreatyData(await client.treaty.v1.memory.status.get());
  json(snapshot);
  out(bold(snapshot.backend));
  if (snapshot.backend === 'mem0') {
    const { ready, error, llm, embedder } = snapshot.mem0;
    out((ready ? '' : red(t('cli.memory.notReady'))) + dim(`  llm: ${llm ?? '-'}  embedder: ${embedder ?? '-'}`));
    if (error) out(red(error));
  }
  if (snapshot.qdrant) out(dim(`  qdrant: ${snapshot.qdrant.phase}`));
}

// Read side of layered memory: the MD fact store (L1), the entity graph (L2), and inferred laws
// (L3). Writes stay in the agent's own tooling and the web panel — this is the operator's window
// into what the agent will actually recall.
export const command: CommandDef = {
  name: 'memory',
  group: 'configure',
  synopsis: 'memory <status|facts|graph|laws> [--scope <kind>:<id>]',
  subcommands: ['status', 'facts', 'graph', 'laws'],
  description: 'inspect what the agent remembers: facts, entity graph, and inferred laws',
  descriptionKey: 'cli.cmd.memory.desc',
  flags: {
    scope: {
      type: 'string',
      description: 'memory scope as kind:id, e.g. agent:agt_x or global:*',
      descriptionKey: 'cli.memory.flag.scope'
    }
  },
  async run({ positionals, flags, client }) {
    const [action = 'status'] = positionals;
    switch (action) {
      case 'status':
        return status(client);
      case 'facts':
        return facts(client, flags);
      case 'graph':
        return graph(client, flags);
      case 'laws':
        return laws(client, flags);
      default:
        throw usageError(t('cli.memory.unknownAction', { action }));
    }
  }
};
