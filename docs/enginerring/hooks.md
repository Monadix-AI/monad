# Lifecycle hooks

Hooks let you observe and steer the agent at fixed lifecycle junctures — inject context,
rewrite a prompt, rewrite or short-circuit a model call, gate or redact a tool call, block a
turn, redact a subagent's result, or force the agent to keep working. One value-based
contract works for both in-process and out-of-process hooks.

Two kinds of hook share that contract:

- **Command hooks** — shell commands, configured in `config.json`. The daemon spawns the
  command, writes the event as JSON to **stdin**, and reads a JSON `HookOutput` from
  **stdout** (exit `2` = deny). Language-agnostic.
- **Atom-pack hooks** — in-process typed TypeScript handlers registered by an atom pack via
  the SDK (`hook({ event, matcher, handler })`). The daemon itself registers a few built-in
  atom hooks (e.g. the memory subsystem injects recalled context on `BeforeTurn`).

## Naming

Flat `<Before|After><Subject>` PascalCase with a self-evident subject (`Turn`, `Model`,
`Tool`, `Compact`, `Subagent`), plus `SessionStart`/`SessionEnd` lifecycle facts and
`ApprovalRequest` for the human approval gate.

**`After*` events fire on BOTH success and failure** — there is no separate failure event.
The failure is carried in the input (`ok` / `error`), and the handler decides what to do.

Source of truth in code:
[`packages/protocol/src/hooks.ts`](../packages/protocol/src/hooks.ts) (contract),
[`apps/monad/src/services/hooks/runner.ts`](../apps/monad/src/services/hooks/runner.ts)
(dispatch), [`packages/home/src/config.ts`](../packages/home/src/config.ts) (`hooks` +
`policyHooks`), [`packages/sdk-atom/src/hook.ts`](../packages/sdk-atom/src/hook.ts) (SDK).

---

## Events

Thirteen events, in firing order. "Can deny / mutate" is what a hook's `HookOutput` may do at
that juncture; fields not relevant to an event are ignored.

| Event | Fires when | Can deny? | Can mutate | Serial/parallel |
|---|---|---|---|---|
| `SessionStart` | a session is created | no | inject context¹ | parallel |
| `BeforeTurn` | before a turn begins | **yes** (abort turn) | rewrite prompt, override model, inject context | serial |
| `BeforeModel` | before each reasoning model call | **yes** (abort) | rewrite the request messages (`mutatedRequest`) | serial |
| `BeforeTool` | before a tool runs | **yes** (skip tool) | rewrite tool input, force the gate (`ask`), inject context | serial |
| `ApprovalRequest` | a tool reaches the approval gate | **yes** (auto-deny) | auto-approve (`allow`), or defer to the human gate | serial |
| `AfterTool` | after a tool runs (success/failure) | no | rewrite tool result; sees `ok`/`error` | serial |
| `AfterModel` | after a reasoning response (success/failure) | no | rewrite the response (`mutatedText`); sees `ok`/`error` | serial |
| `BeforeCompact` | before history compaction | no | inject "what to preserve" into the summary | parallel |
| `AfterCompact` | after history compaction | no | observe | parallel |
| `BeforeSubagent` | before a forked subagent runs | no | inject context into the fork | serial |
| `AfterSubagent` | after a fork finishes (success/failure) | no | rewrite the result (`mutatedText`); sees `ok`/`error` | serial |
| `AfterTurn` | a turn ends (completed/aborted/error) | no | rewrite final text, force continuation (`continueWork`); sees `reason`/`error` | serial |
| `SessionEnd` | a session is deleted | no | observe | parallel |

¹ `SessionStart` context is stashed and injected into that session's **first** `BeforeTurn`.

### Model events — scoping

`BeforeModel` / `AfterModel` fire around the agent's **reasoning** calls only — the main turn
loop **and** forked subagent loops. They do **not** fire for infra/utility model calls
(summarization → use `Before`/`AfterCompact`; embeddings, vision, tool-search, memory have no
model hook). The input's `caller` distinguishes them:

```ts
caller: { kind: 'main' | 'subagent', depth: number, agentName?: string }
```

A hook subscribes to `BeforeSubagent` to bracket a whole fork, or filters `BeforeModel` by
`caller.kind` to scope to main vs subagent reasoning. They fire **per model step** (every
request in a turn — including the intermediate responses that carry tool calls), not once per
turn. That is the distinction from `AfterTurn`: `AfterModel` fires after every reasoning
response; `AfterTurn` fires once, when the turn ends.

---

## The contract

```ts
// HookInput — populated per event (hookInputSchema)
{ event, sessionId, cwd, timestamp,
  prompt?,                                  // BeforeTurn
  toolName?, toolInput?, toolResult?,       // Before/AfterTool, ApprovalRequest
  ok?, error?,                              // After* outcome
  reason?,                                  // AfterTurn / SessionEnd: completed|aborted|error
  usage?, cost?,                            // AfterTurn
  caller?, request?, response?,             // Before/AfterModel
  compaction?: { trigger, tokens },         // Before/AfterCompact
  subagentName?, subagentResult? }          // Before/AfterSubagent

// HookOutput — return nothing to "proceed" (hookOutputSchema)
{ decision?: 'allow' | 'deny' | 'ask', reason?,
  additionalContext?, mutatedPrompt?, modelOverride?,
  mutatedToolInput?, updatedToolOutput?,
  mutatedRequest?,                          // BeforeModel: rewrite request messages
  mutatedText?,                             // AfterModel / AfterSubagent / AfterTurn
  continueWork?: { reason } }
```

---

## Configuration

### Command hooks — `config.json`

`event → matcher[] → hooks[]`. The `matcher` is a regex on the **tool name** and applies only
to the tool-scoped events (`BeforeTool`, `AfterTool`, `ApprovalRequest`); other events always
match.

```jsonc
{
  "hooks": {
    "BeforeTool": [
      { "matcher": "^(shell_exec|fs_write)$",
        "hooks": [{ "command": "./guards/check.sh", "timeoutMs": 5000, "onError": "deny" }] }
    ],
    "AfterModel": [
      { "hooks": [{ "command": "./guards/redact.sh" }] }
    ]
  }
}
```

A command hook receives `HookInput` JSON on **stdin**, runs with `cwd` = the sandbox root:

- **exit 2** → deny (stderr is the reason);
- **exit 0** + JSON stdout → parsed (schema-validated) as `HookOutput`; empty stdout → allow;
- any other failure (non-zero exit, non-JSON, spawn error, **timeout**) → skipped, **unless**
  `onError: "deny"` (fails **closed**);
- env is **sanitized** (`MONAD_*` and `KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL` stripped); default
  timeout 60 s.

### Policy hooks — `policyHooks`

Same shape, but operator-managed and **non-overridable**: they run **before** user `hooks`
and the settings API never writes them. Shell command hooks only.

### Atom-pack hooks — SDK

```ts
import { hook } from '@monad/sdk-atom';
hook({ event: 'BeforeTool', matcher: '^fs_write$', handler: () => ({ decision: 'ask' }), onError: 'deny' });
```

---

## Dispatch semantics

1. **Fast path** — no matching hooks → returns immediately, spawns nothing.
2. **Order & dedup** — atom hooks, then policy command hooks, then user command hooks;
   identical command specs run once per event.
3. **Serial (mutating) events** chain — each hook sees the previous one's rewrite, and the
   **first `deny` short-circuits**. **Parallel events** (`PARALLEL_HOOK_EVENTS`) fan out.
4. **Fail-closed** — a hook's own failure is skipped by default; `onError: 'deny'` turns it
   into a block.
5. **Audit seam** — every executed hook is reported to `deps.record` (outcome + latency).
6. **Hot-reload** — `config`/`policy` resolved per call.

---

## Sequence: one turn

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Loop as Agent loop
    participant H as Hooks
    participant Model
    participant Tool

    Note over Loop,H: session created
    Loop->>H: SessionStart
    User->>Loop: prompt
    Loop->>H: BeforeTurn (+ stashed SessionStart ctx)
    alt denied
        H-->>Loop: blocked → policy reply (turn aborted)
    else proceed
        loop until final answer
            Loop->>H: BeforeModel (caller, request)
            H-->>Loop: rewritten request / deny
            Loop->>Model: stream / complete
            Model-->>Loop: response (+ tool calls)
            Loop->>H: AfterModel (response, ok/error)
            H-->>Loop: rewritten response

            opt tool call
                Loop->>H: BeforeTool
                Loop->>H: ApprovalRequest (if gated)
                H-->>Loop: allow / deny / defer to human
                Loop->>Tool: invoke
                Tool-->>Loop: result
                Loop->>H: AfterTool (ok/error)
            end

            opt window over threshold
                Loop->>H: BeforeCompact → AfterCompact
            end
            opt fork skill
                Loop->>H: BeforeSubagent
                Note over Loop: subagent loop re-fires BeforeModel… (caller=subagent)
                Loop->>H: AfterSubagent (ok/error)
            end
        end
        Loop->>H: AfterTurn (reason: completed | aborted | error)
        Loop-->>User: final answer
    end

    Note over Loop,H: session deleted
    Loop->>H: SessionEnd
```

---

## Examples

**Deny a tool via the gate (auto-deny):**

```jsonc
{ "policyHooks": { "ApprovalRequest": [
  { "matcher": "^shell_exec$", "hooks": [{ "command": "./guards/shell-policy.sh", "onError": "deny" }] }
] } }
```

**Redact every model response (atom pack):**

```ts
hook({ event: 'AfterModel', handler: (i) => ({ mutatedText: redact(i.response ?? '') }) });
```

**Scope a model hook to the main turn only:**

```ts
hook({ event: 'BeforeModel', handler: (i) => (i.caller?.kind === 'main' ? { additionalContext: '…' } : undefined) });
```

---

## Notes & limits

- A `BeforeModel` deny aborts the turn via the error path (`AfterTurn` fires with
  `reason: 'error'`).
- `ApprovalRequest` can auto-deny or auto-approve; `ask`/no-decision defers to the human gate.
- `modelOverride` is applied only if the daemon vouches for the model.
- `continueWork` is bounded by `maxStopContinues`.
- Behaviour is identical over both transports; coverage in
  [`apps/monad/test/e2e/hooks.test.ts`](../apps/monad/test/e2e/hooks.test.ts),
  [`apps/monad/test/unit/hooks-runner.test.ts`](../apps/monad/test/unit/hooks-runner.test.ts),
  and [`apps/monad/test/unit/loop-hooks.test.ts`](../apps/monad/test/unit/loop-hooks.test.ts).
```
