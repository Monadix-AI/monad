# Externalized Prompts with Eta

## Goal

Move every Monad-authored, model-facing behavioral prompt out of TypeScript string literals and into build-time embedded Eta templates. A developer must be able to open the single template for an injection point and inspect the complete message the model receives, with runtime data represented by visible Eta expressions.

## Scope

Externalize daemon-authored system messages, user-message wrappers, behavioral notices, output-format instructions, fallback instructions, and model-facing ambient context. Keep model roles, control flow, tool schemas and descriptions, UI copy, errors, protocol labels, test fixtures, and caller-provided prompts in code.

Each final model message or managed-agent behavioral notice has one complete `*.prompt.md` file. Templates may use interpolation, conditionals, and simple loops. They must not use includes, layouts, blocks, captures, filesystem or network access, or compose another prompt template. Duplication is preferable to hiding part of a prompt in another file.

## Architecture

`apps/monad/src/agent/prompt-template.ts` owns a configured Eta instance and a typed `definePrompt` API. Prompt source is imported statically with Bun's `with { type: 'file' }` mechanism, read once, and rendered with runtime data. This preserves standalone-binary embedding and avoids production filesystem discovery.

Templates are colocated with the feature that owns the injection point. Shared agent-loop prompts remain under `apps/monad/src/agent/prompts/`; memory, transport, skill-review, transcription, external-agent, and Mo templates live in feature-local `prompts/` folders.

Eta is configured with `autoEscape: false`, `autoTrim: false`, `useWith: false`, and synchronous rendering. Prompt content is not HTML, so automatic XML escaping would corrupt code, JSON, transcripts, and identifiers. Untrusted structured values are serialized before rendering; templates are trusted repository source and runtime input is always data, never template source.

## Template Contract

Every prompt definition has a stable ID, statically embedded source path, and TypeScript data type. Rendering trims only the outer file boundary, fails on empty output, and rejects unresolved legacy `{{SLOT}}` placeholders. Prompt IDs are unique.

Eta templates may use `<%= it.value %>`, `<%~ it.preSerializedValue %>`, `if/else`, and simple loops. Source validation rejects `include`, `includeFile`, `layout`, `block`, `capture`, `captureAsync`, `await`, dynamic imports, and direct access to `process`, `Bun`, `fetch`, or filesystem APIs.

Custom agent/workspace prompt bodies remain caller-owned strings. The built-in default system template is rendered with data slots. Optional built-in behavior such as skills and GUI-track instructions lives directly in that one template behind Eta conditionals; TypeScript passes booleans, tool names, and skill records, never instruction fragments.

## Migration Rules

The first migration is mechanically behavior-preserving. Existing prompt wording and message roles remain unchanged unless the one-file constraint requires moving an envelope or conditional into its template. Prompt copy improvements are out of scope.

Model calls that currently have an external system prompt and an inline user wrapper gain a complete user template. Examples include tool search, summary, handoff, transcription cleanup, memory consolidation, graph extraction, law inference, contradiction detection, and skill-install review.

Daemon-authored notices delivered to managed external agents are also prompts. Inbox, busy wake, direct-message, resume-recovery, project Q&A, join, and managed-runtime messages therefore move to complete Eta templates.

## Verification

Tests cover Eta rendering, conditionals, source-policy rejection, empty templates, unique IDs, and static-file loading. Feature tests snapshot or assert complete rendered prompts at representative injection points. A source audit prevents new model-facing behavioral literals from bypassing the prompt renderer. A Bun standalone compile smoke test verifies that Eta templates are embedded in the binary.

Runtime observability may record prompt ID, source path, source hash, role, rendered length, and slot names, but never full rendered prompt content.
