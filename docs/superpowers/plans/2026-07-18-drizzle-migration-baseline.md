# Drizzle Migration Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unpublished SQLite migration history with one Drizzle Kit generated baseline and one handwritten FTS migration.

**Architecture:** Generate a fresh migration tree from the current schema in an isolated temporary directory, then add a Drizzle custom migration slot and restore the handwritten FTS SQL into it. Replace the canonical migration tree atomically, rebuild the embedded bundle, and verify both artifact drift and a real empty-database migration.

**Tech Stack:** Bun, Drizzle Kit 0.31.10, Drizzle ORM, SQLite/FTS5, Bun test.

## Global Constraints

- Keep exactly `0000_initial-schema.sql` as the Drizzle Kit generated relational baseline.
- Keep exactly `0001_message-fts.sql` as the handwritten FTS5 migration.
- Preserve both FTS virtual tables, all three synchronization triggers, and both rebuild statements.
- Existing pre-release database migration hashes are not a compatibility target.
- Generate snapshots and journal metadata with the pinned Drizzle Kit; do not hand-author snapshot JSON.
- Preserve unrelated working-tree changes.

---

### Task 1: Lock the two-migration contract in tests

**Files:**
- Modify: `apps/monad/test/unit/store/migrations.test.ts`

**Interfaces:**
- Consumes: `apps/monad/drizzle/meta/_journal.json` and the runtime `migrate()` function.
- Produces: regression coverage for exact migration tags and final empty-database objects.

- [ ] **Step 1: Add the exact journal-shape assertion**

Extend `generated migrations exactly embed the source Drizzle history` with:

```ts
expect(journal.entries.map((entry) => entry.tag)).toEqual(['0000_initial-schema', '0001_message-fts']);
```

- [ ] **Step 2: Add final-schema assertions to the runtime migration test**

After migrating an in-memory database, assert that historical artifacts are absent and the current schema is present:

```ts
const externalAgentSessionColumns = (
  sqlite.prepare('PRAGMA table_info(external_agent_sessions)').all() as { name: string }[]
).map((row) => row.name);
expect(externalAgentSessionColumns.includes('output_snapshot')).toBe(false);

expect(
  sqlite.prepare("SELECT name, type FROM sqlite_master WHERE name IN ('messages_fts', 'messages_fts_trigram', 'messages_ai', 'messages_ad', 'messages_au') ORDER BY name").all()
).toEqual([
  { name: 'messages_ad', type: 'trigger' },
  { name: 'messages_ai', type: 'trigger' },
  { name: 'messages_au', type: 'trigger' },
  { name: 'messages_fts', type: 'table' },
  { name: 'messages_fts_trigram', type: 'table' }
]);
```

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
bun scripts/bun-test.ts apps/monad/test/unit/store/migrations.test.ts --only-failures
```

Expected: FAIL because the journal still contains `0002_true_iron_monger` and `0003_bent_obadiah_stane`.

### Task 2: Generate the flattened migration tree

**Files:**
- Replace: `apps/monad/drizzle/0000_initial-schema.sql`
- Preserve content: `apps/monad/drizzle/0001_message-fts.sql`
- Delete: `apps/monad/drizzle/0002_true_iron_monger.sql`
- Delete: `apps/monad/drizzle/0003_bent_obadiah_stane.sql`
- Replace: `apps/monad/drizzle/meta/0000_snapshot.json`
- Replace: `apps/monad/drizzle/meta/0001_snapshot.json`
- Delete: `apps/monad/drizzle/meta/0002_snapshot.json`
- Delete: `apps/monad/drizzle/meta/0003_snapshot.json`
- Replace: `apps/monad/drizzle/meta/_journal.json`
- Regenerate: `apps/monad/src/store/db/migrations.generated.ts`

**Interfaces:**
- Consumes: current `apps/monad/src/store/db/schema.ts` and existing `0001_message-fts.sql` content.
- Produces: a two-entry Drizzle migration history and matching embedded runtime bundle.

- [ ] **Step 1: Create an isolated generator directory**

Use `mktemp -d` under `apps/monad` and create a temporary Drizzle config whose `schema` points to the canonical schema and whose `out` points to the temporary migration directory.

- [ ] **Step 2: Generate the relational baseline**

Run the pinned local CLI against the temporary config:

```bash
bun ./node_modules/drizzle-kit/bin.cjs generate --name=initial-schema --config=<temporary-config>
```

Expected: one `0000_initial-schema.sql`, one `0000_snapshot.json`, and one journal entry. Confirm the SQL directly creates the current schema, contains `tool_raw_outputs` and `workplace_projects`, and does not contain `external_agent_observation_events` or `output_snapshot`.

- [ ] **Step 3: Generate the custom migration slot**

Run:

```bash
bun ./node_modules/drizzle-kit/bin.cjs generate --custom --name=message-fts --config=<temporary-config>
```

Expected: `0001_message-fts.sql`, `0001_snapshot.json`, and a second journal entry linked to the baseline snapshot.

- [ ] **Step 4: Restore the handwritten FTS SQL**

Replace the generated empty custom SQL with the existing canonical `0001_message-fts.sql` content. Verify it still contains:

```text
messages_fts
messages_fts_trigram
messages_ai
messages_ad
messages_au
INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')
INSERT INTO messages_fts_trigram(messages_fts_trigram) VALUES ('rebuild')
```

- [ ] **Step 5: Replace the canonical migration tree**

Copy only the two generated SQL files, two snapshots, and journal into `apps/monad/drizzle`. Remove the explicit superseded files listed in this task. Preserve the tags `0000_initial-schema` and `0001_message-fts`.

- [ ] **Step 6: Rebuild the runtime bundle**

Run:

```bash
bun run --cwd apps/monad db:bundle
```

Expected: `migrations.generated.ts` contains exactly two `MigrationMeta` entries and its latest timestamp matches the handwritten migration journal entry.

- [ ] **Step 7: Run focused migration tests and verify GREEN**

Run:

```bash
bun scripts/bun-test.ts apps/monad/test/unit/store/migrations.test.ts apps/monad/test/unit/store/migration-drift.test.ts --only-failures
```

Expected: all focused tests pass, including empty-database FTS synchronization.

### Task 3: Verify repository migration integrity

**Files:**
- Verify only: all Task 1 and Task 2 files.

**Interfaces:**
- Consumes: the flattened migration tree and generated runtime bundle.
- Produces: evidence that generation, history, drift, and runtime initialization agree.

- [ ] **Step 1: Validate Drizzle metadata**

Run:

```bash
bun run db:check
```

Expected: Drizzle Kit reports that all migrations are valid.

- [ ] **Step 2: Validate generated artifact drift**

Run:

```bash
bun run db:drift
```

Expected: exit code 0 and `No schema changes, nothing to migrate` from the isolated generation check.

- [ ] **Step 3: Run daemon typecheck and formatting checks**

Run:

```bash
bun run --filter @monad/monad typecheck
bunx @biomejs/biome check apps/monad/test/unit/store/migrations.test.ts apps/monad/src/store/db/migrations.generated.ts
```

Expected: both commands exit 0.

- [ ] **Step 4: Commit the flattened baseline**

Stage only the migration tree, generated bundle, and migration tests, then commit:

```bash
git commit -m "refactor(db): flatten initial migrations"
```
