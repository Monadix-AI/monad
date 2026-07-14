# UX writing guidelines

Monad UI text should help people understand what the system is doing, decide what
to do next, and recover when something goes wrong. This guide applies to every
human-readable surface: web UI, CLI output, TUI output, daemon console messages,
channel replies, onboarding, notifications, accessibility labels, and docs that
describe product interactions.

This guide is informed by Google's Material communication guidance and Apple's
Human Interface Guidelines for writing. Treat those as background references, not
as a substitute for the product-specific rules below:

- Google Material communication guidance:
  <https://codelabs.developers.google.com/codelabs/material-communication-guidance>
- Apple HIG writing:
  <https://developer.apple.com/design/human-interface-guidelines/writing>

## Core rules

1. Help the user complete the current task.
2. Say what happened, why it matters, and what the user can do next.
3. Keep text short, but never hide consequences or recovery steps.
4. Prefer common words over technical terms.
5. Use the same word for the same concept everywhere.
6. Use active voice and present tense for product behavior.
7. Address the user as `you` when directness helps.
8. Do not mix `you` with `I` or `my` in the same phrase.
9. Write for scanning: put the important noun or action first.
10. Do not use humor, delight copy, or casual filler in errors, approvals, security
    prompts, billing, data-loss, or destructive flows.

## Voice

Monad's voice is:

| Principle | Means | Avoid |
| --- | --- | --- |
| Precise | Name the real object, state, or action. | Vague words like `thing`, `stuff`, `issue`, `something went wrong`. |
| Calm | State facts without blame or drama. | `Oops`, `Uh oh`, jokes, exclamation marks. |
| Direct | Lead with the task or consequence. | Marketing language, feature hype, indirect phrasing. |
| Respectful | Assume the user is capable and busy. | Scolding, overexplaining, fake reassurance. |
| Security-aware | Make trust boundaries and side effects visible. | Hiding host access, credentials, network calls, or destructive changes behind generic labels. |

## Tone by context

Use one consistent voice, but adjust detail and gravity by state.

| Context | Tone | Detail level | Example |
| --- | --- | --- | --- |
| Navigation and labels | Neutral | Minimal | `Sessions` |
| Routine success | Quiet | One short clause | `Branch created` |
| Empty state | Helpful | Goal plus next action | `No worktrees yet. Create one to start isolated development.` |
| Loading | Specific | Current operation | `Loading session history...` |
| Error | Supportive | Cause plus recovery | `The daemon is not reachable. Start it and try again.` |
| Approval | Serious | Action, target, consequence | `Allow file write to docs/ux-writing-guidelines.md?` |
| Destructive action | Explicit | Object, irreversibility, escape | `Delete this credential? This cannot be undone.` |
| Security or privacy | Exact | Data, destination, actor | `Send the selected file path to the model?` |
| Agent activity | Observable | Current step, not speculation | `Reading repository status` |

## Capitalization

Use sentence-style capitalization for all interaction elements and user-facing UI
text. Capitalize only the first word and proper nouns.

This rule applies to:

- Buttons
- Links
- Menu items
- Tabs
- Navigation items
- Page titles
- Dialog titles
- Form labels
- Field placeholders
- Tooltips
- Toasts and snackbars
- Empty states
- Error messages
- Table headers
- Status labels
- CLI headings and prompts

Examples:

| Use | Do not use |
| --- | --- |
| `Create session` | `Create Session` |
| `Open in worktree` | `Open In Worktree` |
| `Approve command` | `Approve Command` |
| `Model provider` | `Model Provider` |
| `Run tests` | `Run Tests` |

Exceptions:

- Preserve official names: `GitHub`, `OpenAI`, `Claude Code`, `Codex`, `Bun`,
  `WebSocket`, `SQLite`, `macOS`.
- Preserve product concepts and technical terms in English when the English term
  is the canonical product vocabulary: `Hooks`, `Workspace`, `MCP`.
- Preserve command, flag, file, package, environment, and schema casing exactly:
  `bun test`, `--json`, `AGENTS.md`, `NODE_ENV`, `sessionId`.
- Preserve user-provided names exactly unless they are unsafe to render.
- Acronyms and initialisms stay uppercase only when that is their standard form:
  `API`, `CLI`, `MCP`, `TLS`, `XDG`.
- If a UI label is quoted or referenced elsewhere, match the label exactly.

Do not use all caps for emphasis. Do not capitalize feature names just because
they are important.

## Grammar and punctuation

- Use present tense for stable product behavior: `Monad stores session history`,
  not `Monad will store session history`.
- Use simple past tense for completed events: `Tests passed`.
- Use future tense only for user-triggered outcomes that have not happened yet:
  `This will delete 3 credentials`.
- Prefer active voice: `Monad saved the file`, not `The file was saved by Monad`.
- Use contractions only when they improve naturalness and do not obscure a
  critical negative: `can't connect` is fine; `does not delete local files` is
  clearer than `doesn't delete local files` in a safety note.
- Use periods for complete sentences. Omit periods from labels, tabs, buttons,
  menu items, chips, and short status fragments.
- Use question marks only for real user decisions.
- Avoid exclamation marks.
- Use numerals for counts, limits, durations, versions, and steps: `3 files`,
  `2 minutes`, `version 1`.
- Prefer `to` in ranges in UI text: `1 to 5` instead of `1-5`.
- Avoid slash constructions when words are clearer: `read or write`, not
  `read/write`, unless referring to an established technical mode.
- Use code formatting in docs for exact strings, paths, commands, keys, flags,
  event names, and schema fields. In product UI, use the component style for code
  or paths instead of quotation marks when available.

## Word choice

Prefer common, concrete words:

| Prefer | Avoid |
| --- | --- |
| `use` | `utilize` |
| `start` | `initialize` when the user is not configuring internals |
| `stop` | `terminate` |
| `change` | `modify` |
| `remove` | `delete` when the object can be restored or is only detached |
| `delete` | `remove` when the object is destroyed |
| `sign in` | `authenticate` |
| `settings` | `configuration` in user-facing UI |
| `folder` | `directory` in non-developer surfaces |
| `worktree` | `checkout` when referring to a Git worktree |
| `session` | `chat` when referring to persisted agent state |
| `model` | `LLM` |
| `provider` | `vendor` |
| `approval` | `permission` when referring to the explicit user decision object |

Avoid invented synonyms. If one surface says `session`, another should not say
`conversation` for the same object.

Define technical terms the first time they appear in onboarding or settings. Do
not define them in compact controls where definition text would slow the task;
link to details or use progressive disclosure.

## Pronouns and ownership

Use `you` and `your` for user-owned action or data:

- `Your session is ready`
- `Choose a workspace`
- `You can resume this session later`

Use product or agent names for system actions:

- `Monad saved the transcript`
- `Codex is reading files`
- `The daemon rejected the request`

Use `my` only when it is part of a user-authored name or an external product label.
Do not write `My sessions` unless the product intentionally names that area that
way. Prefer `Your sessions` or `Sessions`.

Do not combine first and second person:

| Use | Do not use |
| --- | --- |
| `Save your settings` | `Save my settings` |
| `Show your worktrees` | `Show my worktrees for you` |

## Information structure

Start with the user's goal, object, or consequence.

| Context | Structure | Example |
| --- | --- | --- |
| Button | Verb + object | `Create branch` |
| Link | Destination or action | `View logs` |
| Error | Problem + recovery | `Cannot reach the daemon. Start it and try again.` |
| Approval | Action + target + consequence | `Run bun test in this worktree?` |
| Empty state | State + next action | `No credentials yet. Add a provider credential to use models.` |
| Help text | Constraint + reason | `Use a dedicated worktree so local changes stay isolated.` |

Use progressive disclosure:

- Primary UI shows the next useful action.
- Secondary text explains constraints and consequences.
- Details panels show logs, exact command output, stack traces, payloads, or raw
  events.
- Never hide destructive, privacy, cost, network, or host-access consequences
  behind disclosure.

## Interaction elements

### Buttons

Use a short verb phrase that describes the result of clicking the button.

- Good: `Create session`, `Run tests`, `Approve`, `Deny`, `Open logs`
- Bad: `OK` for a meaningful action, `Yes`, `Submit`, `Click here`, `Proceed`

Rules:

- Use sentence-style capitalization.
- Start with a verb unless the button is a compact binary action like `Done`.
- Name destructive actions exactly: `Delete credential`, `Discard changes`.
- Do not use `Cancel` for an action that saves, deletes, or changes state.
- Match the button label to the resulting state when possible: `Archive thread`,
  not `Confirm`.
- For paired actions, make the safer action visually and textually clear:
  `Cancel` and `Delete credential`.
- Use `Done` only to close a completed workflow without changing more data.
- Use `Close` to dismiss a read-only surface.
- Use `Back` for navigation to the previous step.
- Use `Skip` only when the step is optional and can be completed later.
- Avoid ellipses in button labels unless the action opens a required follow-up
  step before completion.

### Links

Links go somewhere. Buttons do something.

- Use destination labels: `View documentation`, `Open settings`, `See logs`.
- Do not write `here`, `learn more`, or raw URLs as link text unless the URL is
  the object being inspected.
- If a link opens an external site, make that visible through UI affordance or
  nearby text.
- If a link opens a file, command, log, or generated artifact, use the actual
  object name.

### Navigation, tabs, and menus

- Use nouns for places: `Sessions`, `Settings`, `Tools`, `Logs`.
- Use verbs for menu commands: `Create worktree`, `Copy path`, `Archive thread`.
- Keep tab labels parallel. Do not mix `Logs`, `Configure`, and `Model settings`
  in the same tab set.
- Do not include the component type in references. Write `Open Settings`, not
  `Open the Settings tab`, unless the component type is needed to disambiguate.

### Form labels

- Use labels, not placeholders, as the primary description.
- Labels should name the requested value: `Branch name`, `Provider`, `API key`.
- Help text should explain format, source, consequence, or recovery.
- Placeholder text may show an example, not repeat the label.
- Error text should appear near the field and say how to fix the value.

Examples:

| Element | Text |
| --- | --- |
| Label | `Branch name` |
| Placeholder | `codex/add-tool-settings` |
| Help | `Use lowercase letters, numbers, hyphens, and slashes.` |
| Error | `Use a branch name without spaces.` |

### Tooltips and help text

Use tooltips for quick clarification, not essential instructions.

- Describe the control, not the pointer gesture.
- Keep tooltips under 12 words when possible.
- Do not put required warnings only in a tooltip.
- Do not repeat visible label text unless the icon has no text.
- For icon-only buttons, the tooltip should be the accessible name.

### Dialogs and modals

Use dialogs for blocking decisions, destructive actions, credentials, permissions,
and critical errors. A dialog should answer:

1. What is happening?
2. What object is affected?
3. What happens if the user confirms?
4. What is the safest escape?

Dialog title:

- Use a short statement or question.
- Name the object or consequence.
- Avoid generic titles like `Confirm`, `Warning`, or `Are you sure?`.

Dialog body:

- Include only information needed for the decision.
- Put irreversible consequences in the first paragraph.
- Show exact targets for file writes, commands, network calls, credential access,
  branch changes, and thread actions.

Actions:

- Primary action matches the outcome: `Delete credential`, `Run command`,
  `Allow file write`.
- Secondary action is usually `Cancel`, `Deny`, or `Close`.

### Toasts, snackbars, and banners

Use transient messages for low-priority confirmations or recoverable updates.
Use banners for persistent states that affect the current view. Use dialogs for
blocking decisions.

Toast rules:

- One idea only.
- No title unless the component requires one.
- Include an action only when it is immediate and safe, such as `Undo` or
  `View logs`.
- Do not use toasts for security prompts, destructive confirmation, or errors
  that require reading details.

Examples:

- `Session archived`
- `Copied path`
- `Tests failed. View logs`

### Empty states

Empty states should explain what is missing and offer the next action.

Structure:

1. State: `No sessions yet`
2. Benefit or context: `Sessions keep the transcript, tool events, and resume state.`
3. Action: `Create session`

Do not blame the user. Avoid jokes. Do not show setup instructions if the action
can be done directly.

### Loading and progress

Loading text should name the current operation.

- Good: `Indexing workspace`, `Loading session history`, `Starting daemon`
- Bad: `Loading`, `Please wait`, `Working on it`

For long operations, expose progress or the current step when possible. Do not
invent certainty. If the app is waiting on another process, say so:

- `Waiting for the daemon`
- `Waiting for model response`
- `Running tests`

### Success states

Keep routine success quiet. Use a short past-tense statement:

- `Settings saved`
- `Branch created`
- `Tests passed`

If the next step is useful, add it as an action:

- `Branch created. Open worktree`

### Error states

Every error should include:

1. What failed.
2. The likely cause, if known.
3. What the user can do next.
4. Where to inspect details, if details exist.

Pattern:

`Cannot [action]. [Reason]. [Recovery].`

Examples:

- `Cannot connect to the daemon. Start it and try again.`
- `Cannot create the branch because it already exists. Choose another name.`
- `Tests failed. View logs for the failing test names.`

Rules:

- Do not say `Something went wrong` unless no better information exists.
- Do not expose raw stack traces in primary UI. Put them in details.
- Do not blame the user.
- Do not tell the user to contact support unless the product has a support path.
- Use exact names for files, branches, tools, providers, and sessions.
- If retry is safe, offer `Try again`. If retry could duplicate work or cost
  money, explain first.

### Confirmations and approvals

Monad often asks users to approve agent actions. Approval copy must be exact.

An approval prompt should include:

- Actor: which agent or process wants to act.
- Action: command, file write, network request, credential access, browser
  control, thread change, or Git operation.
- Target: path, URL, branch, thread, host, provider, or account.
- Scope: read, write, delete, send, run, install, push, or publish.
- Consequence: data changed, data sent, host accessed, cost incurred, or action
  irreversible.

Use consistent verbs:

| Scope | Verb |
| --- | --- |
| Read local files | `Allow file read` |
| Write local files | `Allow file write` |
| Run shell command | `Run command` |
| Use network | `Allow network access` |
| Access credential | `Allow credential access` |
| Send message | `Send message` |
| Delete data | `Delete` |
| Push branch | `Push branch` |
| Create pull request | `Create pull request` |

Never soften risky actions with vague labels like `Continue`, `OK`, or `Proceed`.

### Agent activity and transcripts

Agent UI has two different audiences:

- User-visible timeline: helps the user understand what happened.
- Model-visible transcript: affects future reasoning and resume behavior.

Copy must keep those layers distinct.

Timeline copy:

- State observable work: `Reading AGENTS.md`, `Running bun test`,
  `Editing docs/ux-writing-guidelines.md`.
- Do not claim intent or success before it happens.
- Do not expose hidden prompts, secrets, raw credentials, or full private content
  in compact timeline items.
- Use `Skipped`, `Blocked`, `Failed`, `Completed`, and `Canceled` consistently.

Transcript copy:

- Preserve user and assistant intent accurately.
- Do not convert UI-only events into model-visible instructions.
- Do not summarize approvals in a way that changes scope.

### Model, tool, and permission copy

Use these terms consistently:

| Concept | Use | Avoid |
| --- | --- | --- |
| LLM backend | `model provider` | `AI vendor` |
| Concrete model | `model` | `engine` |
| Tool invocation | `tool call` | `plugin action` unless it is a plugin |
| MCP server | `MCP server` | `integration server` |
| Local shell | `command` | `terminal magic` |
| User approval | `approval` | `permission` when referring to the approval record |
| Sandbox | `sandbox` | `safe mode` |
| Host filesystem | `local files` | `disk` in user UI |
| Credentials | `credential` | `secret` unless referring to secret storage |

When text describes AI output, avoid certainty that the system cannot guarantee.

- Use `Suggested reply`, not `Correct reply`.
- Use `Likely cause`, not `Cause`, unless verified.
- Use `Draft`, not `Message`, until the user sends it.
- Use `Generated summary`, not `Summary`, when provenance matters.

### CLI and terminal output

CLI text should be compact, scriptable, and consistent with UI copy.

- Human-readable output uses sentence-style headings.
- Machine-readable output belongs behind `--json`.
- Errors go to stderr and include stable exit codes where applicable.
- Use exact commands in recovery text.
- Do not use spinners or progress text when `--json` is active.
- Do not localize structured JSON keys or error codes.

Examples:

```text
Daemon is not running.
Start it with: bun run dev
```

```text
Created worktree: /Users/you/Projects/monad-feature
```

## Accessibility writing

Accessible text is product copy. It must be written and reviewed with visible copy.

Rules:

- Every interactive element needs an accessible name.
- Icon-only buttons need an accessible label and usually a tooltip with the same
  action.
- Accessible names should describe the action or destination, not the icon:
  `Archive thread`, not `Archive icon`.
- Do not include `button`, `link`, `image of`, or `picture of` unless needed for
  meaning. Assistive tech already announces roles.
- Alt text should describe the meaningful content or function of an image.
- Decorative images should be hidden from assistive tech.
- Error messages must be programmatically associated with their fields.
- Live status text should be specific enough to be useful when read aloud:
  `Tests failed`, not `Failed`.
- Do not rely on color words alone. Pair them with state names or icons that have
  labels.

Alt text examples:

| Context | Alt text |
| --- | --- |
| Screenshot showing a failed test list | `Test results with 3 failing session tests` |
| Decorative hero texture | Empty alt text |
| Status icon with visible label | Empty alt text |
| Icon-only destructive button | Accessible label: `Delete credential` |

## Internationalization

English is the source language for product strings unless a feature explicitly
starts in another locale. See [ux-guidelines.md](ux-guidelines.md) for what must
and must not be translated.

Writing rules for translation-ready strings:

- Keep strings complete. Do not concatenate sentence fragments.
- Use ICU plural forms for counts.
- Keep variables named and meaningful: `{fileCount}`, not `{n}`.
- Do not embed word order assumptions around variables.
- Do not split a sentence across multiple UI components unless each fragment can
  stand alone.
- Leave enough layout room for translated text to expand.
- Avoid idioms, jokes, sports metaphors, and culture-specific references.
- Keep command names, flags, file paths, event names, API fields, product concepts,
  and technical terms untranslated unless the product has an official localized
  name.
- Use the English source term for canonical product vocabulary and technical
  proper nouns, including `Hooks`, `Workspace`, and `MCP`.

Example:

| Use | Do not use |
| --- | --- |
| `{fileCount, plural, one {# file changed} other {# files changed}}` | `# file(s) changed` |
| `Delete {credentialName}?` | `Delete ` + name + `?` |

## Content matrix

Each durable surface should maintain a small content matrix in the feature spec or
implementation notes. The matrix keeps wording consistent and makes reviews easier.

Required columns:

| Column | Purpose |
| --- | --- |
| Surface | Web, CLI, TUI, channel, notification, dialog, tooltip, aria label. |
| User goal | What the user is trying to do. |
| State | Default, loading, success, error, empty, disabled, approval, destructive. |
| Information need | What the user must know in this state. |
| Final text | Exact source string. |
| Action | Button, link, shortcut, or next step. |
| Terms | Product terms used and avoided. |
| Risk | Data loss, credential, network, host access, cost, privacy, none. |

For small changes, a PR description table is enough. For a broad feature, keep the
matrix near the feature spec or source-of-truth design artifact.

## Review checklist

Before merging user-facing text, verify:

- All interaction elements use sentence-style capitalization.
- The text supports a concrete user task.
- The same concept uses the same term everywhere.
- Buttons describe outcomes, not generic confirmation.
- Errors include recovery.
- Destructive and security-sensitive actions name consequences.
- Loading text names the operation.
- Empty states include a next action.
- Labels do not rely on placeholders.
- Accessible names exist for every icon-only or non-text control.
- Strings are translation-ready and not concatenated from fragments.
- Machine-readable values remain untranslated.
- Agent timeline text does not leak secrets or become model-visible instruction.
- CLI output has a `--json` path when scripts need it.

## Examples

| Situation | Use | Do not use |
| --- | --- | --- |
| Create a new persisted agent session | `Create session` | `New Chat` |
| Open logs after a failure | `View logs` | `Learn more` |
| Destructive credential action | `Delete credential` | `Remove` |
| Approval for shell | `Run bun test in this worktree?` | `Proceed?` |
| Model provider disconnected | `Cannot reach OpenAI. Check the credential and try again.` | `Provider error` |
| Empty worktree list | `No worktrees yet. Create one to isolate your changes.` | `Nothing here!` |
| Loading transcript | `Loading session history` | `Loading` |
| Finished Git action | `Branch pushed` | `Successfully pushed branch!` |
| Disabled submit | `Enter a branch name to continue.` | `Invalid input` |
