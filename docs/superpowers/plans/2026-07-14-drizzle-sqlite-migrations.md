# Drizzle SQLite Migrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Monad's handwritten regular SQLite DDL and `user_version` runner with Drizzle-generated migrations plus ordered custom migrations for FTS5 and future backfills.

**Architecture:** `schema.ts` owns all Drizzle-representable objects and Drizzle Kit generates the SQL history. Custom SQL files share the same Drizzle journal. A generated TypeScript asset index statically embeds the migration directory so `drizzle-orm/bun-sqlite/migrator` works both from source and in the compiled single-file Bun binary.

**Tech Stack:** Bun 1.3.14, TypeScript 7, `bun:sqlite`, Drizzle ORM 0.45.x, Drizzle Kit, Bun test.

## Global Constraints

- Existing development databases may be deleted and rebuilt; no `user_version` bridge is required.
- Generated and custom migrations use one `apps/monad/drizzle` history and one `__drizzle_migrations` table.
- Only FTS5, triggers, rebuild statements, unsupported SQLite DDL, and data backfills may be handwritten SQL.
- Runtime migrations must work in the repository and in the compiled single-file Bun release.
- Applied migration files are immutable; corrections are new ordered migrations.

---

### Task 1: Reconcile the Drizzle schema and generate the initial history

**Files:**
- Modify: `apps/monad/src/store/db/schema.ts`
- Modify: `apps/monad/package.json`
- Modify: `package.json`
- Modify: `bun.lock`
- Create: `apps/monad/drizzle.config.ts`
- Create: `apps/monad/drizzle/0000_*.sql`
- Create: `apps/monad/drizzle/0001_*.sql`
- Create: `apps/monad/drizzle/meta/_journal.json`
- Create: `apps/monad/drizzle/meta/0000_snapshot.json`
- Test: `apps/monad/test/unit/store/migrations.test.ts`

**Interfaces:**
- Consumes: the current SQL shape in `apps/monad/src/store/db/migrations.ts`.
- Produces: a complete `schema.ts` and an ordered Drizzle history containing generated regular DDL followed by custom FTS SQL.

- [ ] **Step 1: Write the failing schema contract test**

Replace version-number assertions with a fresh-database contract that expects `__drizzle_migrations`, representative previously omitted columns, every partial index, both FTS virtual tables, and all six trigger effects across the two FTS indexes. Add a pre-FTS fixture path that inserts a message between the generated migration and the custom migration, then asserts both custom rebuild statements index it.

- [ ] **Step 2: Run the migration test and verify RED**

Run: `bun test apps/monad/test/unit/store/migrations.test.ts`

Expected: FAIL because the current runner creates no `__drizzle_migrations` journal and exposes no generated/custom migration boundary.

- [ ] **Step 3: Add Drizzle Kit configuration and scripts**

Add `drizzle-kit` as a pinned workspace dev dependency compatible with `drizzle-orm@0.45.2`. Configure:

```ts
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/store/db/schema.ts',
  out: './drizzle'
});
```

Expose package scripts for `db:generate`, `db:generate:custom`, `db:check`, and `db:bundle` without using `bunx` floating versions.

- [ ] **Step 4: Make `schema.ts` exhaustive**

Declare every current regular table and index, including `message_embeddings`, `acp_delegates`, the complete `external_agent_inbox_items` columns, composite primary keys, normal indexes, unique indexes, and partial indexes. Export tables used by typed query modules; prefix unused schema-only bindings with `_` only when required by lint, while still exporting them so Drizzle Kit discovers them.

- [ ] **Step 5: Generate regular DDL and add the custom FTS migration**

Run the pinned `drizzle-kit generate --name=initial-schema`, then `drizzle-kit generate --custom --name=message-fts`. The custom migration must create both external-content FTS5 virtual tables, the insert/delete/update triggers, and finish with:

```sql
INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');
INSERT INTO messages_fts_trigram(messages_fts_trigram) VALUES ('rebuild');
```

- [ ] **Step 6: Run the migration test and verify GREEN**

Run: `bun test apps/monad/test/unit/store/migrations.test.ts`

Expected: PASS for schema shape, partial indexes, FTS rebuild, trigger synchronization, and idempotency.

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lock apps/monad/package.json apps/monad/drizzle.config.ts apps/monad/drizzle apps/monad/src/store/db/schema.ts apps/monad/test/unit/store/migrations.test.ts
git commit -m "refactor(db): generate sqlite schema migrations"
```

### Task 2: Embed and run the Drizzle history

**Files:**
- Create: `apps/monad/scripts/generate-migration-assets.ts`
- Create: `apps/monad/src/store/db/migrations.generated.ts`
- Create: `apps/monad/src/store/db/migrations-assets.d.ts`
- Modify: `apps/monad/src/store/db/migrations.ts`
- Modify: `apps/monad/src/store/db/index.ts`
- Modify: `scripts/build-release.ts`
- Test: `apps/monad/test/unit/store/migrations.test.ts`
- Test: `scripts/test/unit/build-release-migrations.test.ts`

**Interfaces:**
- Produces: `migrate(db: BunSQLiteDatabase): void` and `hasCurrentMigration(db: Database): boolean`.
- The generated asset module exports `MIGRATIONS_FOLDER`, resolved from statically imported migration assets.

- [ ] **Step 1: Write failing asset and journal tests**

Add tests that require the generated module to enumerate every journal entry, resolve an existing migration folder in source mode, and make all migration assets discoverable to the Bun release build. Add a journal-status test that deletes the newest row from `__drizzle_migrations` and expects `hasCurrentMigration()` to return false.

- [ ] **Step 2: Run tests and verify RED**

Run: `bun test apps/monad/test/unit/store/migrations.test.ts scripts/test/unit/build-release-migrations.test.ts`

Expected: FAIL because the asset generator and journal-status API do not exist.

- [ ] **Step 3: Generate static migration asset imports**

Implement a deterministic script that reads `drizzle/meta/_journal.json` and writes a TypeScript module containing one `with { type: 'file' }` import per SQL migration plus the journal asset. The module derives `MIGRATIONS_FOLDER` from an imported SQL path and exports the journal timestamp of the newest bundled migration. It must only rewrite the generated file when content changes.

- [ ] **Step 4: Replace the handwritten runner**

Reduce `migrations.ts` to a wrapper around `drizzle-orm/bun-sqlite/migrator` using `MIGRATIONS_FOLDER`. Implement `hasCurrentMigration()` by comparing the newest bundled journal timestamp with the newest `created_at` in `__drizzle_migrations`. Remove `MIGRATIONS`, `CURRENT_SCHEMA_VERSION`, `getSchemaVersion()`, and all `PRAGMA user_version` logic.

- [ ] **Step 5: Initialize Drizzle before migration**

In `Store`, create the Drizzle handle from the existing `bun:sqlite` connection, pass it to the migration wrapper, then expose it as `this.db`. Keep migration execution synchronous.

- [ ] **Step 6: Wire generation into release preparation**

Run the asset generator before `Bun.build` and add a build-focused test proving every journal entry has a static asset import. No runtime temporary directory or copied migration folder is allowed.

- [ ] **Step 7: Run tests and verify GREEN**

Run: `bun test apps/monad/test/unit/store/migrations.test.ts scripts/test/unit/build-release-migrations.test.ts`

Expected: PASS, including journal status and static asset coverage.

- [ ] **Step 8: Commit**

```bash
git add apps/monad/scripts apps/monad/src/store/db/migrations.ts apps/monad/src/store/db/migrations.generated.ts apps/monad/src/store/db/migrations-assets.d.ts apps/monad/src/store/db/index.ts scripts/build-release.ts scripts/test/unit/build-release-migrations.test.ts apps/monad/test/unit/store/migrations.test.ts
git commit -m "refactor(db): run embedded drizzle migrations"
```

### Task 3: Move PRAGMAs to connection initialization and update integrity checks

**Files:**
- Create: `apps/monad/src/store/db/connection.ts`
- Modify: `apps/monad/src/store/db/index.ts`
- Modify: `apps/monad/src/store/home/integrity.ts`
- Modify: `apps/monad/test/unit/store/migrations.test.ts`
- Modify: `apps/monad/test/unit/home/integrity.test.ts`

**Interfaces:**
- Produces: `configureSqliteConnection(sqlite: Database): void`.
- Consumes: `hasCurrentMigration(sqlite)` from Task 2.

- [ ] **Step 1: Write failing PRAGMA and integrity tests**

Assert every Store connection reports `foreign_keys = 1`, `synchronous = 1` (`NORMAL`), and file-backed databases report `journal_mode = wal`. Add an integrity test with a deliberately removed latest journal row and expect `db: 'version-mismatch'`.

- [ ] **Step 2: Run tests and verify RED**

Run: `bun test apps/monad/test/unit/store/migrations.test.ts apps/monad/test/unit/home/integrity.test.ts`

Expected: FAIL because WAL is still migration-owned and integrity still reads `user_version`.

- [ ] **Step 3: Implement connection configuration**

Move all operational PRAGMAs into `configureSqliteConnection()`. Set WAL only for file-backed databases because SQLite memory databases return `memory`; verify the returned mode for file-backed databases and throw if WAL could not be enabled. Apply connection-local foreign-key and synchronous settings on every open.

- [ ] **Step 4: Update Store and integrity**

Call connection configuration before Drizzle migration. Replace `Store.getSchemaVersion()` with `Store.hasCurrentMigration()` and have home integrity preserve its existing public `version-mismatch` result while checking the Drizzle journal.

- [ ] **Step 5: Run tests and verify GREEN**

Run: `bun test apps/monad/test/unit/store/migrations.test.ts apps/monad/test/unit/home/integrity.test.ts`

Expected: PASS for PRAGMA ownership and migration-journal integrity.

- [ ] **Step 6: Commit**

```bash
git add apps/monad/src/store/db/connection.ts apps/monad/src/store/db/index.ts apps/monad/src/store/home/integrity.ts apps/monad/test/unit/store/migrations.test.ts apps/monad/test/unit/home/integrity.test.ts
git commit -m "refactor(db): verify drizzle migration state"
```

### Task 4: Add drift gates and complete regression verification

**Files:**
- Create: `apps/monad/scripts/check-migration-drift.ts`
- Modify: `apps/monad/package.json`
- Modify: `package.json`
- Create: `apps/monad/test/unit/store/migration-drift.test.ts`
- Modify: `apps/monad/test/unit/store/acp-delegates.test.ts`
- Modify: `docs/superpowers/specs/2026-07-14-drizzle-sqlite-migrations-design.md`

**Interfaces:**
- Produces: deterministic `db:drift` and root-level database verification commands.

- [ ] **Step 1: Write the failing drift-script test**

Test the drift checker against a temporary copy of the migration directory and a modified schema fixture. It must fail when generation would produce an uncommitted migration and pass when schema and snapshots agree.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bun test apps/monad/test/unit/store/migration-drift.test.ts`

Expected: FAIL because `check-migration-drift.ts` does not exist.

- [ ] **Step 3: Implement deterministic drift checking**

Run pinned Drizzle generation in an isolated temporary directory seeded with the committed migration history, then compare the resulting tree. Avoid mutating the developer's working tree. Run `drizzle-kit check` as a separate history-consistency gate.

- [ ] **Step 4: Remove legacy version assertions and document commands**

Update remaining tests and exports to use journal status. Amend the design with the exact `db:generate`, `db:generate:custom`, `db:check`, `db:bundle`, and `db:drift` commands used by contributors and CI.

- [ ] **Step 5: Run focused and package verification**

Run:

```bash
bun run --cwd apps/monad db:bundle
bun run --cwd apps/monad db:check
bun run --cwd apps/monad db:drift
bun test apps/monad/test/unit/store/migrations.test.ts
bun test apps/monad/test/unit/store/acp-delegates.test.ts
bun test apps/monad/test/unit/home/integrity.test.ts
bun run --cwd apps/monad typecheck
```

Expected: all commands pass with no generated changes.

- [ ] **Step 6: Run repository change checks**

Run `git diff --check` and inspect `git status --short`. Run the affected package unit suite; report unrelated repository baseline failures separately.

- [ ] **Step 7: Commit**

```bash
git add package.json apps/monad/package.json apps/monad/scripts/check-migration-drift.ts apps/monad/test/unit/store/migration-drift.test.ts apps/monad/test/unit/store/acp-delegates.test.ts docs/superpowers/specs/2026-07-14-drizzle-sqlite-migrations-design.md
git commit -m "test(db): enforce drizzle migration drift checks"
```
