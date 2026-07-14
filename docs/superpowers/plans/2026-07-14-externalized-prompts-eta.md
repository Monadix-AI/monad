# Externalized Prompts with Eta Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Externalize every Monad-authored model behavioral prompt into one complete build-time embedded Eta file per injection point.

**Architecture:** A feature-neutral prompt-template module loads statically imported files and renders trusted Eta source with typed runtime data. Feature modules own complete `*.prompt.md` files and never compose prompt fragments or pass behavioral instructions through data slots.

**Tech Stack:** Bun 1.3, TypeScript 7, Eta 4, Bun test, Biome

## Global Constraints

- One final model message or managed-agent behavioral notice maps to one complete `*.prompt.md` file.
- Templates may interpolate, branch, and loop, but may not include, inherit, lay out, capture, fetch, import, or access runtime globals.
- Runtime values are data only; prompt fragments are forbidden.
- Keep current wording, roles, cache flags, and control flow behaviorally equivalent during migration.
- Templates are statically imported with `with { type: 'file' }` for Bun standalone binaries.
- Do not commit or push; integration remains with the current Codex task unless the user requests Git publication.

---

### Task 1: Eta Prompt Runtime

**Files:**
- Modify: `apps/monad/package.json`
- Modify: `bun.lock`
- Create: `apps/monad/src/agent/prompt-template.ts`
- Create: `apps/monad/test/unit/agent/prompt-template.test.ts`

**Interfaces:**
- Produces: `definePrompt<TData>({ id, sourcePath }): Promise<PromptTemplate<TData>>`
- Produces: `PromptTemplate<TData>.render(data): string`
- Produces: source-policy validation and prompt metadata (`id`, `sourcePath`, `sourceHash`)

- [x] Write tests for successful interpolation/conditionals, stable metadata, empty-output rejection, legacy-slot rejection, and forbidden Eta helpers/globals.
- [x] Run `bun test apps/monad/test/unit/agent/prompt-template.test.ts` and confirm failure because the module and Eta dependency do not exist.
- [x] Add Eta to `@monad/monad` and implement the smallest prompt runtime that satisfies the tests.
- [x] Re-run the focused test and `bun run --cwd apps/monad typecheck`.

### Task 2: Agent Core and Channel Prompts

**Files:**
- Modify: `apps/monad/src/agent/prompts.ts`
- Modify: `apps/monad/src/agent/loop/internal/prompt-builder.ts`
- Modify: `apps/monad/src/agent/loop/index.ts`
- Modify: `apps/monad/src/agent/history.ts`
- Modify: `apps/monad/src/agent/context/index.ts`
- Modify: `apps/monad/src/agent/prompts/channel.ts`
- Replace: `apps/monad/src/agent/prompts/*.md` with complete `*.prompt.md` templates
- Test: `apps/monad/test/unit/agent/prompt-template.test.ts`
- Test: `apps/monad/test/unit/agent/gui-track.test.ts`
- Test: `apps/monad/test/unit/skills/skills.test.ts`
- Test: channel and history unit tests under `apps/monad/test/unit/`

**Interfaces:**
- Consumes: `PromptTemplate<TData>` from Task 1
- Produces: full default-system, budget fallback, summary, reflection, handoff, context-summary, eviction, and direct/worker channel prompts

- [x] Add or update focused tests to assert that complete rendered messages preserve current behavior and that skills/GUI instructions originate from the default system template.
- [x] Run the focused tests and confirm expected failures against the current hardcoded implementation.
- [x] Convert core prompt assets to Eta, remove behavioral constants/fragments from `short-text.ts`, and render templates at their injection points.
- [x] Re-run focused agent, skill, channel, and history tests plus Monad typecheck.

### Task 3: Model Helper and Memory Prompts

**Files:**
- Modify: `apps/monad/src/capabilities/tools/registry/tool-search.ts`
- Modify: `apps/monad/src/capabilities/tools/registry/vision.ts`
- Modify: `apps/monad/src/capabilities/skills/install/review.ts`
- Modify: `apps/monad/src/handlers/settings/model/handlers/transcription.ts`
- Modify: `apps/monad/src/services/memory/index.ts`
- Modify: `apps/monad/src/services/memory/graph/extract.ts`
- Modify: `apps/monad/src/services/memory/law-infer.ts`
- Modify: `apps/monad/src/services/memory/contradict.ts`
- Create/replace: feature-local `prompts/*.prompt.md` files for every system and user injection
- Test: focused tool-search, vision, skill-review, transcription, and memory tests

**Interfaces:**
- Consumes: `PromptTemplate<TData>` from Task 1
- Produces: complete system/user templates for tool search, vision defaults, install review, transcription cleanup, consolidation, graph extraction, law inference, and contradiction checks

- [x] Add focused assertions capturing the complete messages passed to each model helper.
- [x] Run those tests and confirm failure because inline wrappers and hardcoded systems remain.
- [x] Migrate each injection point without changing parsing, model selection, or error handling.
- [x] Re-run focused tests and Monad typecheck.

### Task 4: Transport, Mo, and Managed-Agent Prompts

**Files:**
- Modify: `apps/monad/src/handlers/mo/handlers.ts`
- Modify: `apps/monad/src/transports/http/responses-api/input.ts`
- Modify: `apps/monad/src/transports/http/openai-compat.ts`
- Modify: `apps/monad/src/services/external-agent/managed-project.ts`
- Modify: `apps/monad/src/handlers/session/handlers/messaging-notices.ts`
- Modify: `apps/monad/src/services/native-agent/project.ts`
- Create/replace: feature-local `prompts/*.prompt.md` files for Mo, transport ambient hints, managed runtime, inbox/direct/recovery notices, and project Q&A context
- Test: `apps/monad/test/unit/mo-drop.test.ts`
- Test: managed-project, transport, and native-agent project unit tests

**Interfaces:**
- Consumes: `PromptTemplate<TData>` from Task 1
- Produces: complete user/notice templates for every daemon-authored external-agent or transport injection

- [x] Add focused tests for each conditional rendering path and complete message envelope.
- [x] Run the focused tests and confirm failure while strings are still assembled in TypeScript.
- [x] Move behavioral text and formatting loops into complete Eta templates; leave routing and raw caller messages in code.
- [x] Re-run focused tests and Monad typecheck.

### Task 5: Prompt Audit and Release Verification

**Files:**
- Create: `apps/monad/test/unit/agent/prompt-source-audit.test.ts`
- Modify: release/build test or script only if the existing standalone build lacks a prompt-asset assertion

**Interfaces:**
- Consumes: all prompt definitions and templates from Tasks 1-4
- Produces: regression guard against inline daemon-authored behavioral prompts and orphan prompt assets

- [x] Write a source-audit test that fails on known remaining inline behavioral prompt literals and forbidden Eta composition helpers.
- [x] Run it and confirm RED with exact remaining paths.
- [x] Remove or explicitly classify every remaining match; ensure every `*.prompt.md` is statically imported and every model-facing behavioral message is rendered through a prompt definition.
- [x] Run focused prompt tests, `bun run --cwd apps/monad typecheck`, `bun run --cwd apps/monad test:unit`, and a standalone release build or equivalent compile smoke test.
- [x] Review `git diff --check`, `git status --short`, and the full diff; report unrelated baseline failures separately.
