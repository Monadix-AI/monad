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

Generated and custom migration files are immutable after merge. Corrections
are expressed as later migrations. A change that combines schema evolution and
data conversion is split into ordered phases, for example: add nullable column,
custom backfill, then add the non-null constraint.

## Runtime

Database startup performs these operations in order:

1. Open the `bun:sqlite` connection.
2. Apply and verify operational PRAGMAs.
3. Wrap the connection with `drizzle-orm/bun-sqlite`.
4. Run `drizzle-orm/bun-sqlite/migrator` against `apps/monad/drizzle`.
5. Construct the Store only after migrations complete.

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

## Drift Prevention

The package exposes commands to generate migrations and check migration
history. CI verifies all three layers:

- Running Drizzle generation against the committed schema must not create or
  modify migration artifacts.
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
