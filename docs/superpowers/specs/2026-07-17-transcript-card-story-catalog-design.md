# Transcript Card Story Catalog Design

## Goal

Give every card or row that can appear in a Chat Session or Chat Experience transcript a discoverable Storybook example. Cover one representative example per kind, the meaningful controlled or lifecycle states for stateful cards, and one complete transcript composition per surface.

## Structure

Use two Storybook catalogs that follow the production ownership boundary:

- `packages/ui/stories/chat-cards.stories.tsx` owns presentation-only shared cards and the Chat Experience composition built from them.
- `apps/web/stories/session-transcript.stories.tsx` owns Chat Session-specific transcript cards and the complete Chat Session composition.

Do not add these examples to the existing oversized `All Components` stories. Do not duplicate production card markup in story-only components when the production component can be rendered directly.

## Story Coverage

### Shared and Chat Experience catalog

Provide representative stories for:

- human and agent workspace messages;
- system and developer events;
- attachments;
- user, agent, tool, and system observations;
- command execution;
- file read;
- generic tool call and result pairs;
- read-only external-agent approval observations;
- inline raw provider JSONL inspection.

State stories cover:

- expanded and collapsed observations;
- open and closed raw inspection;
- successful, running, and failed command execution;
- collapsed, loading, expanded, and error attachment states;
- sending and failed/retry message presentation.

The catalog ends with `Complete Chat Experience`, a realistic ordered transcript that combines the representative card kinds without introducing application data dependencies.

### Chat Session catalog

Provide representative stories for:

- user and assistant messages;
- reasoning;
- directives;
- single tool calls;
- parallel tool groups;
- skill calls;
- external-agent login;
- memory summary;
- compact lifecycle rows;
- branch and restore controls;
- summary transcript turns;
- generic approvals;
- resource approvals;
- clarification prompts.

Tool and lifecycle stories cover successful, running, and failed states where the production component supports them. Interactive stories use local React state or Storybook actions and never call the daemon, RTK, or browser download APIs.

The catalog ends with `Complete Chat Session`, rendering the production transcript components in a realistic sequence with inert callbacks.

## Controlled Behavior

Stories must preserve the production ownership rules:

- controlled components keep their state in the story wrapper;
- presentation components receive plain props and slots;
- raw inspection receives ordered provider or transport JSONL strings;
- Chat Session approval remains interactive;
- External Session approval remains a read-only observation;
- no story imports daemon, client, protocol, or Experience data layers into `@monad/ui`.

## Coverage Contract

Export stable story-case ID lists from the two catalogs or from adjacent fixture modules. Add a focused test that asserts the exact expected IDs for both surfaces. The contract catches accidental removal or renaming of a transcript kind without relying on weak presence-only DOM assertions.

Story rendering and typechecking provide the component contract check. Existing component tests remain the source of truth for behavior.

## Verification

Run:

```bash
bun scripts/bun-test.ts packages/ui/test/unit/chat-card-stories.test.ts apps/web/test/unit/session-transcript-stories.test.ts --only-failures
bun run --cwd packages/ui typecheck
bun run --cwd apps/web generate:routes
bun run --cwd apps/web typecheck
bun run lint
```

If the repository exposes a Storybook build command for either surface, build both catalogs to catch bundler-only failures. Finish with the repository-wide typecheck and test gates required for changes on `main`.
