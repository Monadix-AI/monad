// Contradiction detection: does any CURRENT fact state the opposite of an existing law? /consolidate
// re-derives laws wholesale from current facts, so a law can only contradict reality in the window
// between a new opposing fact arriving and the next re-derivation — this is the lighter check for
// that window. One cheap LLM call per scope; the flagged laws are suppressed from recall.

import type { Logger } from '@monad/logger';
import type { Complete } from './graph/extract.ts';

const SYSTEM = [
  'You check whether any RULE is contradicted by the current FACTS about one user/agent.',
  'A contradiction means a fact states the OPPOSITE of what a rule claims — not merely an unrelated',
  'fact or a new topic. Each rule is tagged [r#] and each fact [f#].',
  'Output ONLY JSON: {"contradictions":[{"rule":"r1","fact":"f2"}]} citing only the tags shown below;',
  'output {"contradictions":[]} if nothing genuinely contradicts.'
].join(' ');

const cap = (s: string, max: number): string => (s.length > max ? s.slice(0, max) : s);

export interface RawContradiction {
  rule: string;
  fact: string;
}

/** Pull the first balanced JSON object and validate the {contradictions:[{rule,fact}]} shape. */
export function parseContradictions(text: string): RawContradiction[] | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const arr = (raw as { contradictions?: unknown }).contradictions;
  if (!Array.isArray(arr)) return null;
  const out: RawContradiction[] = [];
  for (const c of arr) {
    if (typeof c !== 'object' || c === null) continue;
    const o = c as Record<string, unknown>;
    if (typeof o.rule === 'string' && typeof o.fact === 'string') out.push({ rule: o.rule, fact: o.fact });
  }
  return out;
}

export interface DetectedContradiction {
  lawId: string;
  factContent: string;
}

/** Ask the model which laws a current fact contradicts; map the cited tags back to real ids/content,
 *  dropping anything it invents. Returns at most one contradicting fact per law. */
export async function detectContradictions(
  complete: Complete,
  model: string,
  laws: { id: string; statement: string }[],
  facts: { content: string }[],
  maxChars = 8000
): Promise<DetectedContradiction[]> {
  if (laws.length === 0 || facts.length === 0) return [];
  const ruleRef = new Map(laws.map((l, i) => [`r${i + 1}`, l]));
  const factRef = new Map(facts.map((f, i) => [`f${i + 1}`, f.content]));
  const rulesBlock = cap(laws.map((l, i) => `[r${i + 1}] ${l.statement}`).join('\n'), maxChars / 2);
  const factsBlock = cap(facts.map((f, i) => `[f${i + 1}] ${f.content}`).join('\n'), maxChars / 2);

  const text = await complete(model, SYSTEM, `Rules:\n${rulesBlock}\n\nFacts:\n${factsBlock}`);
  const parsed = parseContradictions(text);
  if (!parsed) return [];

  const out: DetectedContradiction[] = [];
  const seen = new Set<string>();
  for (const c of parsed) {
    const law = ruleRef.get(c.rule);
    const fact = factRef.get(c.fact);
    if (law && fact !== undefined && !seen.has(law.id)) {
      seen.add(law.id);
      out.push({ lawId: law.id, factContent: fact });
    }
  }
  return out;
}

export interface CheckContradictionsDeps {
  scopes: () => { scope: string; kind: 'global' | 'agent' | 'project'; id: string }[];
  laws: (scope: string) => { id: string; statement: string }[];
  facts: (kind: 'global' | 'agent' | 'project', id: string) => Promise<{ content: string }[]>;
  mark: (scope: string, byLawId: Map<string, string>) => void;
  complete: Complete;
  model: (scope: string) => string;
  log: Logger;
}

export interface CheckResult {
  flagged: number;
}

/** Per scope: detect contradictions between its laws and current facts, then store the flags. */
export async function checkContradictionsForScopes(deps: CheckContradictionsDeps): Promise<CheckResult> {
  let flagged = 0;
  for (const s of deps.scopes()) {
    const laws = deps.laws(s.scope);
    if (laws.length === 0) continue;
    const facts = await deps.facts(s.kind, s.id);
    let hits: DetectedContradiction[];
    try {
      hits = await detectContradictions(deps.complete, deps.model(s.scope), laws, facts);
    } catch (err) {
      deps.log.warn(`contradict: check(${s.scope}) failed: ${String(err)}`);
      continue;
    }
    // Always write (even an empty map) so a now-resolved contradiction is cleared.
    deps.mark(s.scope, new Map(hits.map((h) => [h.lawId, h.factContent])));
    flagged += hits.length;
  }
  deps.log.info(`contradict: flagged ${flagged} law(s)`);
  return { flagged };
}
