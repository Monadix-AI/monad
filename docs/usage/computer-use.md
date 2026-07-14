# Computer use & browser use

monad lets the agent *see and operate a GUI* through off-the-shelf MCP servers — monad
ships no automation server of its own, it connects existing ones and applies its gate,
tool-pinning, and image-passthrough on top. There are **two distinct capabilities**, on
two tracks; pick by task:

| | **computer-use** (pixel / OS) | **browser-use** (DOM / a11y) |
|---|---|---|
| Sees | screenshots → vision model | DOM / accessibility tree (+ optional screenshot) |
| Acts | coordinate clicks, key/type, scroll, drag | navigate, click(selector), fill, extract, snapshot |
| Scope | anything on screen, incl. native apps | web pages only |
| Reliability / cost | lower / higher (image tokens) | higher / lower |
| Security | drives the real machine — host-escape (see below) | domain-scopable, far more contained |

Rule of thumb the agent should follow: **web task → browser-use; native app / canvas /
no-a11y UI → computer-use.** Default to browser; fall back to computer when browser can't reach it.

Both are **off by default**. Both flow through the same MCP client, approval gate, and
tool-set pinning as any other MCP server (`docs/internals/runtime.md`, `docs/engineering/security-guidelines.md`).

## Screenshots reach the model

Any image an MCP tool returns (a screenshot) is surfaced to the model as a real image
content part — never JSON-stringified into text. The raw bytes ride a side channel so a
megabyte of base64 never lands in the persisted/text result (`apps/monad/src/capabilities/tools/mcp.ts`,
`normalizeMcpResult` / `toModelOutput`). This is what makes *both* tracks usable.

## Browser use

Enable the Playwright MCP preset (Microsoft's official server — accessibility-tree
grounding, cross-browser, the de-facto default for agent web automation):

```jsonc
// config.json
"browser": {
  "enabled": true,
  "headless": true,
  "engine": "chrome",            // chrome | firefox | webkit | msedge
  "allowedOrigins": ["https://example.com"],   // optional navigation allowlist (opt-in)
  "blockedOrigins": ["https://ads.example"],
  "autoApproveReadOnly": true     // snapshot/screenshot/reads don't prompt; navigate/click/type still gate
}
```

The daemon synthesizes a `browser` MCP server (`npx @playwright/mcp`). Read-only tools are
auto-approved; mutating tools (navigate/click/type/evaluate) route through the gate.

**Alternative servers.** A user-defined `mcpServers` entry named `browser` takes precedence
over the preset, so you can point at any other server:
- **chrome-devtools-mcp** (Google, CDP) — best for Chrome debugging / performance traces /
  network inspection, or driving your real logged-in Chrome. Chrome-only; a good *alternative*,
  not a better default.
- **Stagehand** (Browserbase) — natural-language act/extract/observe, robust to layout drift.
- **Browserbase** — managed cloud browser (CDP-as-a-service).

## Computer use

Computer-use drives your **real desktop** — that is the point, so it is *not* sandboxed.
Enable it explicitly:

```jsonc
// config.json
"computer": {
  "enabled": true,
  "command": "uvx",                        // overridable — point at any desktop-control MCP
  "args": ["computer-control-mcp@latest"],
  "autoApproveReadOnly": true              // screenshot/cursor/size/window-list don't prompt
}
```

The daemon synthesizes a `computer` MCP server. The default targets the cross-platform
[AB498/computer-control-mcp](https://github.com/AB498/computer-control-mcp) (PyAutoGUI + OCR,
via `uvx`); override `command`/`args` to use another (e.g. [MCPControl](https://github.com/claude-did-this/MCPControl),
or a sandboxed/remote desktop like [trycua](https://www.trycua.com) / e2b desktop).

### Security model: host-escape (the sanctioned exception)

monad's default posture is *contain the agent*. Computer-use can't be contained — it moves
the real mouse/keyboard — so it is treated as a **host-escape capability**, the same class as
`code_execute` running on the host. The exception is explicit and bounded, not silent:

- **Read-only** tools (screenshot, cursor, screen size, window list) are auto-approved.
- **Mutating** tools (click/type/drag/key/scroll) are tagged with the `host-control` gate key
  (`trust.hostEscape: true` on the server → `capabilities/mcp/service.ts`).
- The approval engine treats `host-control` as a **class grant**: one "control this computer
  for this session" approval covers *all* mutating actions (no per-click prompt), and it
  **expires with the session**.
- A host-control allow **can never persist** beyond session scope — no permanent global/agent
  "always allow" (`HostEscapePersistError` in `services/approvals/engine.ts`). A **deny** at any
  scope always wins, so an operator can hard-disable it.

Compensating controls (since there's no containment): the active grant is visible and revocable
via the approvals panel. Never run computer-use unattended on untrusted content — on-screen text
can prompt-inject the agent.

**High-stakes actions stay always-ask.** A `deny` rule wins over any allow at every scope, so an
operator can carve dangerous actions out of the session grant. Recommended baseline in `config.json`
(tool names track your chosen server; adjust to match):

```jsonc
"agent": {
  "approvals": {
    "deny": [
      // never let a host-control session grant cover these — re-prompt every time:
      // (use the server's real tool names; these are computer-control-mcp examples)
    ]
  }
}
```

Mirroring the computer-use MCP's own rule: **do not execute trades, place orders, or move money**
on the user's behalf — keep those, and irreversible/destructive actions, on explicit per-action
approval (or deny them outright and have the user perform them).

## Provider-native acceleration (optional)

A tool may declare a provider-native binding (`ToolSpec.providerTool`); when the active
provider matches, the adapter emits the provider's built-in tool instead of a generic
function tool (`packages/atoms/src/providers/ai-sdk-adapter.ts`). For Claude this means the
trained `computer_20250124`/`computer_20251124` tool. The portable generic path is the
fallback, so GPT/Gemini still work. Wiring a synthetic `computer` tool that maps the native
action set onto a chosen server's tools is future work.

## Tests

- `apps/monad/test/unit/tools/mcp.test.ts` — image passthrough (bytes off the text channel).
- `packages/atoms/test/unit/provider-tools.test.ts` — Anthropic native tool emission + generic fallback.
- `packages/home/test/unit/home.test.ts` — browser/computer presets + `hostEscape`.
- `apps/monad/test/unit/approvals-engine.test.ts` — host-control class grant + persistence cap.
- `apps/monad/test/e2e/computer-use-e2e.test.ts` — a screenshot reaches the model through the real loop.
- `apps/monad/test/e2e/host-escape-wiring.test.ts` — a hostEscape server's mutating tools get the gate key.
