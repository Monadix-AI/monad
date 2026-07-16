# Proposal: skill usage observability

Status: draft · Scope: design only (no implementation yet)

## Problem

Monad has no visibility into **which skills actually get used**. We can't tell a load-bearing
skill from dead weight, can't order the `/` menu by relevance, can't auto-suggest disabling a
skill nobody invokes, and self-authoring (`skill_manage`) has no usage signal to learn from. The
auto-load switches (config `skills.autoload`/`disabled`) are operated blind.

Goal: capture lightweight per-skill usage — counts, recency, outcome — and surface it, without
recording argument content (which can carry secrets).

## What to capture

A single `skill.activated` event at each activation point. The loop already has the seam:
`AgentLoop.activateSkill(name)` is called on every model-load and `/name` invocation — emit there
(plus the fork + L3-resource paths).

```ts
interface SkillActivatedPayload {
  skill: string;
  source: 'model' | 'user';   // skill tool vs /name
  mode: 'inline' | 'fork' | 'resource';
  tier?: 'fast' | 'smart' | 'power';
  sessionId: SessionId;
  at: string;                 // ISO timestamp
  outcome: 'ok' | 'error';
  // NO argument content — name + metadata only (args may contain secrets).
}
```

## Where it lives

Reuse the existing pipeline — `store.appendEvents` + `EventBus` already persist + fan out events
to clients. Add `skill.activated` to the protocol event union, emit from the loop, and:

- **Aggregate** into a small `skill_usage` rollup (a `@monad/store` table or KV counters via the
  existing `KvServer`): per skill → `count`, `lastUsedAt`, `errorCount`, `bySource`.
- **Query** via a new `skills.stats` JSON-RPC method (+ REST), returning the rollup.

## How it's surfaced

- `monad skills` CLI gains a usage column (count · last used).
- The web `/` menu can order matches by recency/frequency instead of discovery order.
- `skills.list` items can carry optional `usage` so clients show it inline (additive field).
- Feeds the auto-load switches: "12 skills never used in 30 days — disable their auto-load?"
  (the operator decides; nothing auto-changes).

## Privacy & security

- **Metadata only** — skill name, counts, timestamps, source/mode. Never argument text or body.
- **Local** — usage stays in the daemon's store/KV; not transmitted anywhere.
- Counts are not security-sensitive, but the no-argument rule keeps secrets out of the rollup.

## Phasing

1. **Emit + count** — `skill.activated` event from `activateSkill`, KV/store rollup. No UI yet.
2. **Query + CLI** — `skills.stats` RPC + `monad skills` usage column.
3. **Relevance** — menu ordering by recency/frequency; `skills.list` `usage` field.
4. **Suggestions** — surface never-used skills to the operator for the auto-load denylist; feed
   recency into self-authoring so the agent revises stale skills.

## Open questions

- Rollup store: a dedicated SQLite table (durable, queryable) vs KV counters (fast, simpler)?
  Lean SQLite for durable history + recency queries.
- Retention: keep raw `skill.activated` events (audit trail) or only the rollup? Probably rollup +
  a capped recent-events ring for debugging.
- Should usage influence the model-facing L1 ordering too (most-used first), or only the user menu?
