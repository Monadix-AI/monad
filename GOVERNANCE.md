# Governance

How decisions get made in this project, so contributors know what to expect before
investing time.

## Current model

Monad is **company-stewarded**. It is developed and maintained by Monadix Labs, Inc.,
released under the [MIT License](LICENSE), and open to outside contribution. Final say on
scope, architecture, and release timing rests with the maintainers listed in
[`.github/CODEOWNERS`](.github/CODEOWNERS), who are required reviewers on the areas they
own.

This is a description of how the project works today, not a promise that it will never
change. If the contributor base grows to the point where this model is the bottleneck, the
model should change — and that change belongs in this file.

## How a change is decided

The bar scales with the blast radius:

| Change | Path |
|---|---|
| Bug fix, docs, test, self-contained improvement | Open a PR. Review + green CI is the whole gate. |
| New behavior inside an existing subsystem | Issue or Discussion first to agree the approach, then a PR. |
| New contract, new package, or a change to a documented boundary | A proposal in [`docs/internal/proposals/`](docs/internal/proposals/) stating contracts, migrations, and the evidence it needs — reviewed before code. |
| Direction, non-goals, roadmap | Maintainer decision, recorded in [ROADMAP.md](ROADMAP.md) or the relevant design doc. |

The repository's own documents are the medium of record. A decision that is not written
down in `docs/` did not happen — that convention is what keeps the engineering docs usable
as a source of truth (see [philosophy.md](docs/engineering/philosophy.md)).

## Review and merge

- Every change lands through the quality gate in [CONTRIBUTING.md](CONTRIBUTING.md):
  lint, typecheck, and the full test suite, across the Linux/macOS/Windows matrix.
- `CODEOWNERS` review is required for the paths it covers.
- Releases are cut by [release-please](https://github.com/googleapis/release-please) from
  Conventional Commit history; the release PR is the human gate for `stable` and `beta`.
  See [releases](docs/usage/releases.md).

## Security decisions

Vulnerability reports follow [SECURITY.md](SECURITY.md) and are handled privately by the
maintainers until a fix ships. Security fixes take precedence over release cadence and may
be released out of band.

## Becoming a maintainer

There is no formal committer ladder yet. Sustained, high-quality contribution and
demonstrated judgement about the project's boundaries are what would lead to an invitation
and a `CODEOWNERS` entry. If you are working toward that, say so — it is easier to hand
over ownership of an area to someone who has already been reviewing it.

## Code of Conduct

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). Enforcement is a
maintainer responsibility.
