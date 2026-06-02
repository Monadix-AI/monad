// L2 consolidation: the two-phase pass behind /consolidate-graph. Forward = per-session, extract the
// messages past each session's watermark and upsert nodes/edges (support = that span's messageIds).
// Reconcile = a support-liveness sweep so messages deleted (soft-delete active=0, or a removed
// session) retract their edges. All deps injected so it's testable with no model/store wiring.

import type { Logger } from '@monad/logger';
import type { L2Provider } from './types.ts';

import { type Complete, extractGraph } from './extract.ts';

export interface GraphMessage {
  id: string;
  role: string;
  text: string;
}
interface GraphSession {
  id: string;
  /** v1 writes to `agent:<id>`; a session with no agent is skipped. */
  agentId: string | null;
}

export interface GraphConsolidateDeps {
  store: L2Provider;
  /** All sessions to consider (new ones get consolidated from the start). */
  sessions: () => GraphSession[];
  /** Active messages after a session's watermark (null cursor ⇒ from the start), in order. */
  messagesAfter: (sessionId: string, afterMessageId: string | null) => GraphMessage[];
  /** Liveness for reconcile: a messageId still present AND active. */
  isAlive: (messageId: string) => boolean;
  complete: Complete;
  /** Model id for a span's agent (the `memory` role). */
  extractModel: (agentId: string) => string;
  /** Skip sessions with fewer than this many new PROSE messages (default 4). */
  minNewMessages?: number;
  /** Cap the transcript fed to one extraction call (default 12000 chars ≈ ~3k tokens). A longer span
   *  is processed across passes — bounds the cost of any single LLM call. */
  maxTranscriptChars?: number;
  log: Logger;
}

export interface GraphConsolidateResult {
  sessionsScanned: number;
  sessionsExtracted: number;
  nodes: number;
  edges: number;
  prunedEdges: number;
}

const norm = (s: string): string => s.trim().toLowerCase();

/** Background catch-up gate: on only when enabled AND at least `intervalMinutes` have elapsed since
 *  the last run. A coarse timer can call this each tick so a hot-reloaded interval/flag just works. */
export function graphAutoDue(
  cfg: { autoConsolidate?: boolean; intervalMinutes?: number } | undefined,
  lastRunMs: number,
  nowMs: number
): boolean {
  if (!cfg?.autoConsolidate) return false;
  const intervalMs = Math.max(1, cfg.intervalMinutes ?? 30) * 60_000;
  return nowMs - lastRunMs >= intervalMs;
}

export async function consolidateGraph(deps: GraphConsolidateDeps): Promise<GraphConsolidateResult> {
  const minNew = deps.minNewMessages ?? 4;
  const maxChars = deps.maxTranscriptChars ?? 12_000;
  let scanned = 0;
  let extracted = 0;
  let nodes = 0;
  let edges = 0;

  for (const ses of deps.sessions()) {
    if (!ses.agentId) continue; // v1: agent scope only
    scanned++;
    const cursor = deps.store.getCursor(ses.id);
    const msgs = deps.messagesAfter(ses.id, cursor);
    if (msgs.length === 0) continue;
    const absoluteLast = msgs[msgs.length - 1];

    // Cost control 1: only feed substantive prose to the LLM — tool output/results (often huge) carry
    // little graph signal and dominate token count.
    const prose = msgs.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text.trim().length > 0);
    if (prose.length < minNew) {
      if (absoluteLast) deps.store.setCursor(ses.id, absoluteLast.id); // nothing worth extracting — skip past it
      continue;
    }

    // Cost control 2: cap one extraction's transcript to a char budget; the tail (past the budget) is
    // picked up on the next pass, since the cursor advances only to the last message we actually fed.
    const batch: GraphMessage[] = [];
    let chars = 0;
    for (const m of prose) {
      const len = m.role.length + m.text.length + 2;
      if (batch.length > 0 && chars + len > maxChars) break;
      batch.push(m);
      chars += len;
    }

    const scope = `agent:${ses.agentId}`;
    const transcript = batch.map((m) => `${m.role}: ${m.text}`).join('\n');
    let graph: Awaited<ReturnType<typeof extractGraph>>;
    try {
      graph = await extractGraph(deps.complete, deps.extractModel(ses.agentId), transcript);
    } catch (err) {
      deps.log.warn(`graph: extract(${ses.id}) failed — leaving cursor for retry: ${String(err)}`);
      continue; // don't advance the cursor → retried next pass
    }
    if (!graph) {
      deps.log.warn(`graph: extract(${ses.id}) produced no parseable graph — leaving cursor`);
      continue;
    }

    const support = batch.map((m) => m.id);
    // Resolve relation endpoints to node ids, upserting any endpoint the entity list missed so an edge
    // is never dropped for a naming gap.
    const idByName = new Map<string, string>();
    const resolve = (name: string): string => {
      const key = norm(name);
      const hit = idByName.get(key);
      if (hit) return hit;
      const id = deps.store.upsertNode({ scope, name });
      idByName.set(key, id);
      nodes++;
      return id;
    };
    for (const n of graph.nodes) {
      const key = norm(n.name);
      if (idByName.has(key)) continue;
      const id = deps.store.upsertNode({ scope, name: n.name, type: n.type, aliases: n.aliases });
      idByName.set(key, id);
      nodes++;
    }
    for (const e of graph.edges) {
      const src = resolve(e.src);
      const dst = resolve(e.dst);
      if (src === dst) continue; // skip self-loops
      deps.store.upsertEdge({
        scope,
        src,
        dst,
        relation: e.relation,
        provClass: 'machine',
        support,
        confidence: e.confidence ?? 0.6
      });
      edges++;
    }

    // Advance only to the last message we actually fed — a budget-truncated tail is picked up next pass.
    const fedLast = batch[batch.length - 1];
    if (fedLast) deps.store.setCursor(ses.id, fedLast.id);
    extracted++;
  }

  // Reconcile: drop dead support, retract edges left unsupported, prune orphan cursors.
  const liveSessions = new Set(deps.sessions().map((s) => s.id));
  for (const sid of deps.store.knownSessions()) if (!liveSessions.has(sid)) deps.store.dropCursor(sid);
  const { prunedEdges } = deps.store.reconcile(deps.isAlive);

  deps.log.info(
    `graph: consolidated ${extracted}/${scanned} session(s) → +${nodes} node(s), +${edges} edge(s); reconcile pruned ${prunedEdges}`
  );
  return { sessionsScanned: scanned, sessionsExtracted: extracted, nodes, edges, prunedEdges };
}
