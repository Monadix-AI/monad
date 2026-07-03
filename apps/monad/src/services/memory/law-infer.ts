// L3 inference: one LLM pass per scope over its L1 facts + L2 graph → general, falsifiable "laws".
// Self-built (no vendor ecosystem). Wholesale per-scope replace (no incremental support tracking).
// Cost-gated like L2: cheap `memory`-role model, a char budget, and a minimum-input floor.

import type { Logger } from '@monad/logger';
import type { Complete } from './graph/extract.ts';
import type { LawStore } from './law-store.ts';

import { fingerprint } from './consolidation-state.ts';

export interface InferredLaw {
  statement: string;
  confidence?: number;
  support?: string[];
}

const INFER_SYSTEM = [
  'You derive a few GENERAL, FALSIFIABLE rules ("laws") that should guide an assistant, by generalizing',
  'the durable facts and relations below about one user/agent. A law is a stable, actionable',
  'generalization — e.g. "Always deploy with Bun, never Node" — not a restatement of a single fact.',
  'Each fact is tagged [f#] and each relation is tagged [e#].',
  'Output ONLY JSON: {"laws":[{"statement":"…","confidence":0.0-1.0,"support":["f1","e3"]}]} where `support`',
  'lists the [f#]/[e#] tags the law generalizes (cite only tags shown below; omit if none apply).',
  'Be conservative: prefer 0-5 high-signal laws over many weak ones. If nothing generalizes, output {"laws":[]}.'
].join(' ');

const cap = (s: string, max: number): string => (s.length > max ? s.slice(0, max) : s);

/** Pull the first balanced JSON object and validate the {laws:[…]} shape. */
export function parseLaws(text: string): InferredLaw[] | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const arr = (raw as { laws?: unknown }).laws;
  if (!Array.isArray(arr)) return null;
  const out: InferredLaw[] = [];
  for (const l of arr) {
    if (typeof l !== 'object' || l === null) continue;
    const o = l as Record<string, unknown>;
    if (typeof o.statement !== 'string' || !o.statement.trim()) continue;
    out.push({
      statement: o.statement.trim(),
      confidence: typeof o.confidence === 'number' ? Math.max(0, Math.min(1, o.confidence)) : undefined,
      support: Array.isArray(o.support) ? o.support.filter((s): s is string => typeof s === 'string') : undefined
    });
  }
  return out;
}

async function inferLaws(
  complete: Complete,
  model: string,
  factsBlock: string,
  graphBlock: string
): Promise<InferredLaw[] | null> {
  const text = await complete(
    model,
    INFER_SYSTEM,
    `Facts:\n${factsBlock || '(none)'}\n\nRelations:\n${graphBlock || '(none)'}`
  );
  return parseLaws(text);
}

interface LawScopeRef {
  scope: string;
  kind: 'global' | 'agent' | 'project';
  id: string;
}

export interface InferLawsDeps {
  store: LawStore;
  scopes: () => LawScopeRef[];
  /** L1 facts for a scope, with stable ids — so a derived law can cite the facts it generalizes. */
  facts: (kind: 'global' | 'agent' | 'project', id: string) => Promise<{ id: string; content: string }[]>;
  /** L2 relations for a scope, with edge ids + a short rendered line (e.g. "Zeke —[works_on]→ Monad"). */
  graphItems: (scope: string) => { id: string; text: string }[];
  complete: Complete;
  model: (scope: string) => string;
  /** Skip a scope with fewer than this many facts+relations to generalize from (default 3). */
  minInputs?: number;
  /** Char budget for the facts+relations fed to one inference call (default 8000). */
  maxChars?: number;
  /** Incremental: skip a scope whose (fact + edge) input set is unchanged since the last derivation. */
  state?: { get(key: string): string | null; set(key: string, fp: string): void };
  log: Logger;
}

export interface InferResult {
  scopesProcessed: number;
  laws: number;
  /** Scopes left untouched because their inputs were unchanged (incremental skip). */
  skipped: number;
}

export async function inferLawsForScopes(deps: InferLawsDeps): Promise<InferResult> {
  const minInputs = deps.minInputs ?? 3;
  const half = (deps.maxChars ?? 8000) / 2;
  let processed = 0;
  let total = 0;
  let skipped = 0;

  for (const s of deps.scopes()) {
    const facts = await deps.facts(s.kind, s.id);
    const edges = deps.graphItems(s.scope);
    if (facts.length + edges.length < minInputs) continue; // too little to generalize — leave existing laws

    // Incremental skip: if the input set (fact + edge ids) is unchanged since the last derivation, the
    // existing laws are still valid — don't pay for a re-derivation.
    const fp = fingerprint([...facts.map((f) => `f:${f.id}`), ...edges.map((e) => `e:${e.id}`)]);
    if (deps.state?.get(`l3:${s.scope}`) === fp) {
      skipped++;
      continue;
    }

    // Short ref tags ([f1]/[e1]) keep the prompt cheap and the model's citations reliable; map each
    // back to the real fact/edge id afterwards so a law's support is a verifiable provenance link.
    const factRef = new Map(facts.map((f, i) => [`f${i + 1}`, f.id]));
    const edgeRef = new Map(edges.map((e, i) => [`e${i + 1}`, e.id]));
    const factsBlock = cap(facts.map((f, i) => `[f${i + 1}] ${f.content}`).join('\n'), half);
    const graphBlock = cap(edges.map((e, i) => `[e${i + 1}] ${e.text}`).join('\n'), half);
    let laws: InferredLaw[] | null;
    try {
      laws = await inferLaws(deps.complete, deps.model(s.scope), factsBlock, graphBlock);
    } catch (err) {
      deps.log.warn(`laws: infer(${s.scope}) failed: ${String(err)}`);
      continue;
    }
    if (!laws) {
      deps.log.warn(`laws: infer(${s.scope}) produced no parseable laws`);
      continue;
    }
    deps.store.replaceLaws(
      s.scope,
      laws.map((l) => ({
        scope: s.scope,
        statement: l.statement,
        confidence: l.confidence ?? 0.6,
        // Resolve cited tags to real ids; drop any the model invented (no hallucinated provenance).
        support: (l.support ?? [])
          .map((ref) => {
            const f = factRef.get(ref);
            if (f) return `fact:${f}`;
            const e = edgeRef.get(ref);
            return e ? `edge:${e}` : null;
          })
          .filter((r): r is string => r !== null)
      }))
    );
    deps.state?.set(`l3:${s.scope}`, fp);
    processed++;
    total += laws.length;
  }

  deps.log.info(`laws: inferred for ${processed} scope(s), ${total} law(s) total, ${skipped} unchanged`);
  return { scopesProcessed: processed, laws: total, skipped };
}
