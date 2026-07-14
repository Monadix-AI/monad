# Engineering Philosophy

> AI changes the bottleneck of software engineering from code production to code verification. A good engineering system should therefore make correct code the path of least resistance and incorrect code mechanically difficult to express.

---

## Part I — Principles

### Core Idea

We optimize for constrained creativity: humans define product intent, architecture, and invariants; AI fills in implementation inside narrow, typed, validated pathways. The goal is not to remove human judgment, but to spend it on decisions that cannot be automated.

### Vibe Coding, Guardrailed

Human attention has become the new production bottleneck. AI can generate code continuously, but if quality control depends on humans reviewing every line, the ceiling on collaboration is still human throughput.

Our strategy is therefore: **bake quality into the toolchain rather than rely on manual review.**

That means deliberately introducing more guardrails and constraints — hard type boundaries, lint rules, schema validation, enforced boilerplate, unified abstraction layers. These constraints are mechanical and tedious for humans, but AI doesn't complain about them. The tighter the constraints, the harder it is for AI to go off-rails and produce code that runs but isn't right.

The higher friction cost on the engineering side buys us higher confidence in AI-assisted output. The trade-off is worth it.

One corollary: constraints should reduce choice at the call site, not hide essential behavior behind vague abstractions. An abstraction that makes incorrect usage impossible is good engineering; an abstraction that merely defers comprehension is review debt in disguise.

### Tests Are Review Compression

Tests are not primarily evidence that humans wrote correct code. In an AI-assisted workflow, they are a mechanism for compressing the cost of human review: a reviewer who can run a suite and see green does not need to mentally simulate every code path in a diff.

This changes what good tests look like. The goal is not 100% line coverage for its own sake; it is maximal *decision coverage* at minimal reading cost. A well-named integration test that exercises a complete user-facing behavior tells a reviewer more than twenty unit tests that verify individual functions in isolation.

When AI generates implementation code, tests should be written (or generated and reviewed) before the diff is merged. The test is the human-authored specification; the implementation is the AI's answer. Accepting an implementation without a corresponding test inverts that relationship.

### Documentation as AI Control Surface

Documentation files are the primary lever for shaping AI behavior. You do not need to write them line by line yourself — that is exactly what AI is for. But you do need to read them line by line.

As long as a file is visible to the AI (attached, in context, or referenced), every sentence in it becomes a constraint on what the AI will produce. Precise documentation is therefore not bureaucratic overhead; it is the mechanism by which humans retain control over AI-assisted output without reviewing every generated line.

The practical implication: when AI produces something unexpected, the first question is not "what did the AI do wrong?" but "what was absent or ambiguous in the documentation?" Fix the document, not just the output. The next generation will be better because the rule is now encoded, not because the AI was corrected once.

### Single Source of Truth, End to End

SSOT is not just a data modeling principle — it is the organizing principle of the entire engineering system, from runtime types to toolchain configuration.

**In code:** every type, schema, and constant has exactly one authoritative definition. Consumers import and derive from it; they never redeclare. A zod schema at a wire boundary is the definition — the TypeScript type is derived from it via `z.infer`, not written separately. A duplicated type is a latent disagreement waiting to surface.

**In configuration:** every tool setting has one home. `tsconfig.json` owns compiler options; `biome.json` owns lint and format rules; `turbo.jsonc` owns the build graph. When a rule needs to change, there is exactly one place to change it. Scattering the same constraint across multiple config files creates the same drift problem as duplicating types — the copies will eventually diverge.

**In documentation:** `AGENTS.md` is the single source of truth for agent instructions. `docs/engineering/conventions.md` owns code style rules. Topic-specific docs own their domain. When guidance is needed in multiple places, one file is the authority and the others reference it — they do not restate it.

The payoff in AI-assisted workflows is asymmetric: AI is very good at following a single clear rule and very bad at resolving contradictions between two rules that apply to the same situation. Every duplication is a fork in the road where AI may take the wrong branch. SSOT eliminates the fork.

### Let AI Refactor; Keep the Boundary Tight

Over-engineering is expensive when humans do it: abstraction takes time to design, time to explain, and time to unwind if it turns out to be wrong. The conventional advice — don't abstract until the second duplication — exists because the refactoring cost falls on people.

That calculus flips with AI. Abstraction and simplification are nearly free to execute: ask AI to consolidate duplicated logic, extract a shared utility, or flatten an awkward call chain, and it will do so correctly in seconds. The only real cost is verifying the result — and that cost is bounded by the quality of the test suite.

The practical rule: as business logic grows more complex, actively use AI to keep the code simpler. Don't let complexity accumulate because "a refactor isn't worth it right now." With AI, it almost always is.

The one discipline this requires: control the effect boundary before the refactor starts. Identify which files and interfaces will change, ensure they are covered by tests, and make clear to AI what must not change externally — public API shape, wire format, observable behavior. A refactor that simplifies internals while holding the boundary invariant is safe. A refactor that drifts the boundary is a breaking change, regardless of how clean the result looks.

---

## Part II — Concrete Decisions

### Why TypeScript / JavaScript Instead of Other Languages

**End-to-end isomorphism.** A single language across the entire stack — CLI, daemon, server, web, and mobile clients — means types, validation schemas, and protocol definitions are defined once and imported everywhere. No translation layer, no drift between what the server sends and what the client expects.

**The richest AI training corpus.** Like it or not, TypeScript and JavaScript are among the most popular, fastest-growing languages in the world, with the most mature toolchains and ecosystems. Open-source TS/JS projects account for a disproportionate share of the data AI models are trained on. That depth of training material translates directly into higher-quality AI-generated code — fewer hallucinated APIs, fewer subtle logic errors, better adherence to idioms.

**TypeScript's type system as a harness.** TypeScript has one of the most modern and expressive type systems available: discriminated unions, template literal types, conditional types, infer, satisfies — the full spectrum from loose duck-typing to provably correct narrowing. This expressiveness is not for showing off; it is the mechanism by which we constrain what AI is allowed to produce. A tight schema or a branded type is a machine-checkable rule that AI cannot argue with.

**Constrainable complexity means more reviewable code.** TypeScript and JavaScript have their own sharp edges — type gymnastics, prototype chains, async boundary subtleties, build-tool variance. The point is not that they are inherently simple. The point is that their complexity is *enforceable*: a strict `tsconfig`, a biome ruleset, a zod schema at every runtime boundary, and a codegen layer for repetitive structure together push AI toward legible, idiomatic output. In languages with richer or more esoteric feature sets, complexity can surface in forms that no lint rule covers — metaprogramming, macro systems, type-level proofs — which are technically correct but opaque to most contributors.

This matters for a project that depends on community creativity for rapid growth. A contributor who understands the product goal but is not a language expert should be able to read a pull request, understand what it does, and form a judgment about whether it is right — without first needing to master the host language's full feature surface. If AI-generated code is correct but incomprehensible, it is not an asset; it is review debt with interest.

### Why RTK Query Instead of TanStack Query

TanStack Query is extremely flexible — a virtue when humans write the code, but a liability in AI-assisted workflows. Flexibility means AI can easily sidestep the coding conventions we describe in natural language and complete a task in a way that is technically valid but stylistically out of step with the project.

RTK Query's boilerplate is the feature, not a downside:

- The fixed `createApi` / `endpoints` / `useXxxQuery` structure leaves AI almost no room to deviate.
- Deep Redux store integration means caching, invalidation, and optimistic updates all travel the same path — no "let me try a different approach this time."
- Consistent patterns at review time let humans focus on business logic without having to evaluate whether the data-fetching strategy is sound.

The costs are real: more initial boilerplate, stronger Redux coupling, heavier setup for simple cases, and ongoing discipline around tag invalidation. We accept them because, in an AI-assisted workflow, the predictability return outweighs the setup cost.

### Respect System Environment Variables; Avoid Private Ones

Monad respects well-known system-level environment variables (e.g. `PATH`, `HOME`, `NODE_ENV`) but does not introduce its own private ones unless strictly necessary.

The reason is observability: environment variables are implicit and hard to inspect, while config files are explicit declarations users can read, diff, and audit. When something behaves unexpectedly, a user should be able to find the answer in `config.json` or a `--flag`, not by hunting for a hidden `MONAD_*` variable that was set somewhere.

The rule of thumb:
- Feature configuration → `config.json` user settings
- Daemon behavior → `--flag` argv
- Cross-process values → reuse existing system env vars; never mint new private ones
