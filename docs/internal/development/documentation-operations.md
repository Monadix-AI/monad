---
title: "Documentation Operations"
audience: "internal-developer"
sidebarTitle: "Docs Operations"
description: "Maintain, validate, publish, localize, and measure the Monad documentation site."
keywords: ["Mintlify", "documentation CI", "localization", "SEO", "docs analytics"]
---
The `docs/` directory contains the Mintlify content root and repository-only documentation. Public pages remain the single source of truth for the hosted site. Mintlify excludes `internal/` through `.mintignore`.

## Local validation

Run the repository gate before publishing:

```bash
mise run quality:docs
```

It checks that every public Markdown page is mapped once, verifies internal audience markers, validates frontmatter and code-fence metadata, runs the Mintlify build validator, and checks public links and redirect destinations. Use `mint dev` from `docs/` for visual review.

The hosted site intentionally has no OpenAPI reference. Developers inspect the checkout's live routes through local Scalar; see [Developer experience](dx.md#inspect-the-local-daemon-api-with-scalar).

## Content rules

- Give every rendered page a specific title and description.
- Put user outcomes before implementation detail.
- Keep English product vocabulary stable inside Chinese prose when it names a protocol or product object.
- Label code fences with a language, including `text` for plain output.
- Add redirects only when a published URL actually moves.
- Put unshipped proposals in `docs/internal/proposals/`; do not publish them as hidden pages.

## Dashboard launch checklist

The following settings live outside the repository and require a Mintlify project administrator:

1. Configure the production custom domain and DNS.
2. Add the resulting canonical domain and search-console verification metadata.
3. Enable feedback, analytics, and Assistant analytics after reviewing the privacy disclosure.
4. Enable blocking broken-link and Vale checks for pull requests when the plan supports them.
5. Review low-confidence searches, unanswered Assistant queries, and negative feedback on a regular cadence.
6. Confirm `/sitemap.xml`, `/robots.txt`, `/llms.txt`, and `/mcp` on the production domain.

Never commit Dashboard API keys or analytics export credentials. The documentation privacy boundary is described in [Data and network](../../usage/privacy.md#documentation-site-data).
