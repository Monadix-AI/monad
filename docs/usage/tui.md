---
title: "Terminal UI"
sidebarTitle: "Terminal UI"
description: "Start Monad's terminal client and learn the few keys needed to drive it."
keywords: ["Monad TUI", "terminal UI", "keyboard shortcuts", "terminal client"]
---
The TUI is a keyboard-first client for people who want a live transcript without leaving
the terminal. It talks to the same daemon as everything else, so it shows the same
sessions, projects, and approvals.

Everything here can also be done with `monad` commands ([CLI reference](/usage/cli)) or in
the browser ([web UI](/usage/web)). Use the TUI to watch and steer a conversation; use the
CLI to script.

## Start it

```bash
monad tui
```

If the daemon is not running, the TUI offers to start it first. When idle, press `Ctrl+C`
twice to leave.

## Use it

- Type in the composer and press `Enter` to send; `Shift+Enter` or `Ctrl+J` inserts a
  newline.
- Sending while a reply streams queues the message. `Ctrl+Enter` steers instead: it stops
  the current run and starts a replacement turn with your text.
- `Ctrl+C` during a run stops that run rather than exiting.
- Typing `/` opens the same command and skill menu the CLI and channels dispatch.
- Approvals open as a detail view. Approve and reject each need a second `Enter`, and a
  rejection can carry a reason.

Keys worth remembering:

| Keys | Action |
|---|---|
| `Ctrl+K` | Command palette — the fastest way to any screen |
| ``Ctrl+` `` | Workspace chat |
| `Ctrl+,` | Settings |
| `Ctrl+P` | Plan panel |
| `?` | Help |
| `Esc` | Close or go back |
| `Tab` / `Shift+Tab` | Move focus |

The layout adapts to terminal width; below roughly 60 columns the TUI asks you to resize.

## What it does not do

The TUI renders chat, projects, inbox, and settings. Screens that need diagrams, visual
editors, or a browser flow — Workplace Experiences, interactive third-party agent sign-in, Atom
Pack install consent — are marked as such and offer to open the matching web route.
Third-party agent activity is read-only here: drive a runtime with `monad mesh input` or the web
UI.
