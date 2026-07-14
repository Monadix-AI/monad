# Drizzle and SQLite Migration Design

## Goal

Make `apps/monad/src/store/db/schema.ts` the single source of truth for every
SQLite object Drizzle can represent, while retaining a small, ordered custom
SQL layer for SQLite-specific objects and data migrations. Both generated and
custom migrations must be executed by the Drizzle migrator and recorded in one
`__drizzle_migrations` history.

Existing development databases may be deleted and rebuilt. No bridge from the
current `PRAGMA user_version` migration history is required.

## Ownership

`schema.ts` owns all regular tables, columns, primary keys, defaults, and
indexes, including partial indexes. Drizzle Kit snapshots this file and
generates the corresponding SQL migrations.

Custom Drizzle migrations own only features that Drizzle Kit cannot represent
or infer:

- FTS5 virtual tables.
- Triggers that synchronize external-content FTS indexes.
- FTS rebuild statements.
- Data backfills and SQLite-specific DDL not supported by Drizzle Kit.

Connection initialization owns PRAGMAs whose behavior is connection-scoped or
operational, including WAL mode. `PRAGMA user_version` no longer controls or
reports migration state.

## Migration Layout

Drizzle Kit is configured for SQLite with
`apps/monad/src/store/db/schema.ts` as its schema input and
`apps/monad/drizzle` as its migration output.

The rebuilt history starts with two migrations:

1. A Drizzle-generated initial migration containing every regular table and
   index.
2. A custom migration containing the two FTS5 virtual tables, their insert,
   update, and delete triggers, and an FTS rebuild for existing messages.

Subsequent regular schema changes use `drizzle-kit generate`. Unsupported DDL
and backfills use `drizzle-kit generate --custom`. Both forms remain in the
same ordered migration directory and use the same Drizzle journal.

At build time, `apps/monad/scripts/generate-migration-assets.ts` reads the
committed journal and SQL files and emits one deterministic inline
`MigrationMeta[]` bundle at `src/store/db/migrations.generated.ts`. The runtime
ships this module directly; it does not rely on a type=`file` migration folder
being present beside a packaged binary.

Generated and custom migration files are immutable after merge. Corrections
are expressed as later migrations. A change that combines schema evolution and
data conversion is split into ordered phases: update `schema.ts` and run
`db:generate` to add a nullable column in a generated migration, then run
`db:generate:custom` to append a separate backfill migration. After deploying
and verifying the backfill, update `schema.ts` and run `db:generate` again to
add a later migration that enforces the non-null constraint.

## Runtime

Database startup performs these operations in order:

1. Open the `bun:sqlite` connection.
2. Apply and verify operational PRAGMAs.
3. Wrap the connection with `drizzle-orm/bun-sqlite`.
4. Pass the generated inline `MigrationMeta[]` to the Drizzle
   `SQLiteSyncDialect` with the Bun SQLite session.
5. Construct the Store only after migrations complete.

Runtime migration does not read `apps/monad/drizzle`. That directory is the
committed generation source; `migrations.generated.ts` is the packaged runtime
input passed to `SQLiteSyncDialect.migrate()`.

The existing hand-written `MIGRATIONS` array, `CURRENT_SCHEMA_VERSION`,
`getSchemaVersion()`, and `PRAGMA user_version` checks are removed. Home
integrity validation checks that the Drizzle migration journal has applied the
latest bundled migration rather than comparing an application-maintained
integer.

## FTS Lifecycle

The custom FTS migration creates `messages_fts` and
`messages_fts_trigram` as external-content FTS5 tables backed by `messages`.
Three triggers keep both indexes synchronized for insert, update, and delete.
The migration finishes by rebuilding both indexes so rows created before the
FTS objects are indexed.

Future FTS definition changes use a new custom migration that explicitly drops
the old triggers and virtual tables, recreates them, and rebuilds both indexes.
`CREATE IF NOT EXISTS` alone is not sufficient because it cannot update an
existing definition.

## Contributor Workflow and Drift Prevention

All migration commands use the pinned local `drizzle-kit` `0.31.4`; no command
uses a floating `bunx` installation. From the repository root, the package
scripts are `bun run db:generate`, `bun run db:generate:custom`, `bun run
db:bundle`, `bun run db:check`, and `bun run db:drift`. Their application-level
equivalents are available through `bun run --cwd apps/monad <command>`.

For a normal schema change, update `schema.ts`, run `bun run db:generate`,
review and retain every generated SQL and snapshot artifact, run `bun run
db:bundle` to regenerate the inline bundle, then run `bun run db:check` and
`bun run db:drift`. For a mixed change, first update `schema.ts` and run `bun
run db:generate` so Drizzle snapshots the representable schema change. Then run
`bun run db:generate:custom` to append a separate migration for unsupported
SQLite DDL or a data backfill, and replace its placeholder with reviewed SQL.
A custom migration alone does not snapshot the current schema. After both
migrations exist, run `bun run db:bundle` and the same checks. Never edit a
committed migration, journal entry, or snapshot; add a new ordered migration
instead.

`db:check` is Drizzle's snapshot collision and history consistency check.
`db:drift` is separate and read-only: it copies the committed `drizzle` history
to a temporary directory, runs the pinned generator against the real schema,
and fails if the temporary history differs. It also renders the expected inline
bundle in memory and compares it to `migrations.generated.ts`. Neither check
rewrites `apps/monad/drizzle`, `schema.ts`, or the generated bundle.

CI verifies all layers:

- Running Drizzle generation against the committed schema must not create or
  modify temporary migration artifacts.
- `migrations.generated.ts` must exactly match the committed migration journal
  and SQL source files.
- `drizzle-kit check` must accept the snapshot history.
- A fresh database must successfully run every migration and a second migrate
  call must be a no-op.
- Contract tests inspect representative regular tables and partial indexes.
- Behavioral tests verify FTS insert, update, delete, and initial rebuild.
- Runtime tests verify the required PRAGMA values.

Tests do not maintain a second exhaustive handwritten list of all schema
columns. Drizzle snapshots cover the regular schema; explicit assertions focus
on custom behavior and previously observed schema omissions.

## Initial Schema Reconciliation

Before generating the initial migration, `schema.ts` is expanded to match the
current database shape. This includes currently missing tables, columns,
primary keys, and indexes such as `message_embeddings`, `acp_delegates`, the
full external-agent inbox shape, and all ordinary and partial indexes declared
by the existing SQL migration.

The resulting initial generated migration and custom FTS migration are tested
against an empty SQLite database. Existing local database files must be removed
and recreated after this change.
