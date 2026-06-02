# Documentation structure

The `docs/` tree contains the public Mintlify site and repository-only documentation. Classify a page by audience and publication status before adding it.

| Publication | Audience | Location | Content |
|---|---|---|---|
| Mintlify | Users and operators | `getting-started.md`, `product.md`, `concepts.md`, `guides/`, `usage/`, `zh-Hans/` | Product concepts and tasks people perform with Monad |
| Mintlify | Developers | `internals/`, `engineering/`, `design/` | Public contracts, architecture, extension mechanisms, engineering philosophy, technology choices, and product design foundations |
| Repository only | Coding agents | `internal/agents/` | Agent coordination and repository-specific agent guidance |
| Repository only | Developers | `internal/development/`, `internal/proposals/` | Contribution rules, development practices, migrations, operations, and unshipped proposals |

Mintlify excludes `internal/` through `.mintignore`. Removing an internal page from `docs.json` is not enough because a hidden Mintlify page remains reachable by URL.

## Decide where a page belongs

Publish a page when someone can use it to operate Monad, build against a public contract, understand shipped architecture, or author an extension. Keep a page internal when it controls how this repository is changed, records an unshipped design, coordinates agents, or documents a development-only migration.

Do not duplicate a rule in a public architecture page. Explain the stable principle publicly and keep repository enforcement in `internal/development/`.

## Maintain the site

Run `mise run quality:docs` after moving or editing documentation. The check requires every published Markdown page to appear exactly once in `docs.json`, rejects navigation entries without files, validates public frontmatter and code fences, and validates internal audience markers and relative links.

The complete maintenance and publication workflow lives in [`internal/development/documentation-operations.md`](internal/development/documentation-operations.md).
