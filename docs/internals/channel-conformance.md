# Channel conformance

We can't develop against every third-party IM platform, so our channel adapters follow a single
normalization and routing contract, and each adapter is pinned to that contract's behavior. This
is the conformance contract; the tests live in
`apps/monad/test/unit/channel-conformance.test.ts` (+ `telegram` normalization is a pure, tested
function `normalizeTelegramMessage`).

## Shared contracts

| # | Behavior | Rule | Our implementation | Test |
|---|---|---|---|---|
| A1 | Text source | `text` XOR `caption`, never concatenated; media-only → media kind | `normalizeTelegramMessage` | A1 |
| A2 | Command parse | strip leading `/`, strip `@suffix`, **lowercase**; args follow | `normalizeTelegramMessage` | A2 |
| A3 | Self/echo | drop messages from the bot's own id | `isSelf` + core echo guard | A3, C-self |
| A8 | Dedup | suppress a re-delivered message by its native id | core LRU on `nativeMessageId` | C-A8 |
| B9 | DM keying | one session per (channel, chatId) | `deriveKey` per-conversation | C-B9 |
| C11 | **Length limit** | split long replies at the platform char limit | `splitForLimit` in `render.ts` | B-split, B-render |
| E18 | Disallowed user | **SILENT drop** — no "denied" reply, no session | core allowlist drop | C-E18 |
| D16 | Long-poll | advance offset = `update_id + 1`; reconnect w/ backoff | `telegram.ts` poll loop | smoke |
| F1 | **DM access policy** | pairing / allowlist / open / disabled | `allowlist.policy` + core `accessDecision` | access:* |
| F2 | **Pairing flow** | unknown DM sender → one-time code, operator approves | core `issuePairing` / `consumePairing` + `POST /channels/:id/pair` | pairing:* |
| F3 | **Group require-mention** | answer in a group only when @mentioned/replied-to | `groupPolicy.requireMention` + core group gate | group gate:* |
| F4 | **Per-channel agent hint** | a per-channel hint steers which agent handles the turn | `agentHint` → `origin.ext` → `ambientContext` | agentHint:* |

Contracts this pass added: command lowercasing (`/NEW` == `/new`), outbound chunking at
`maxMessageChars`, the **DM access policy + pairing flow**, the **group require-mention gate**, and
the **per-channel agent hint**. We also grew from one channel (Telegram) to four adapters spanning
all three inbound styles — long-poll (Telegram), dial-out WebSocket (Discord Gateway, Slack Socket
Mode), and inbound webhook.

## Design decisions (where platform conventions differ, we pick a stance)

| Behavior | Options | Our stance |
|---|---|---|
| `@suffix` in commands | strip ANY `@x`, or strip only when `@x` == bot username | **strip any `@x`** (simpler; bots don't see other-bot commands anyway) |
| Command namespace | treat any `/word` as a command, or only a registered alias set | **hybrid** — the adapter marks any `/word` as `kind:command`; the CORE only acts on known commands (`/new /switch /sessions /end`), unknown → treated as normal text (so `/path/to/file` is not executed) |
| Group per-user isolation | per-user, or chat/topic-scoped (shared) | **configurable** — `mapping.granularity`: `per-conversation` (default) or `per-user` |
| Edited messages | drop, or record for reply-chain with no new turn | **drop** — we subscribe to `message` only (no `edited_message`); observably "not answered" |
| Default DM gate | open/env-enabled, or pairing (one-time code) | **`allowlist` default-deny** — pairing is opt-in via `allowlist.policy: 'pairing'` (deny-by-default is the safe baseline, with the pairing UX offered on top) |

## Deliberately NOT matched (out of scope / by design)

- **Markdown**: our Telegram adapter sends plain text (`markdown:false`) to avoid MarkdownV2 parse
  failures. (We chose robustness over rich formatting for v1.) (Discord/Slack adapters set their own
  `markdown` capability.)
- **Progressive-edit throttle constants**: we throttle edits at ~1.2s. Same shape, different
  constants from any given platform's batch delays.
- **Media passthrough**: `media[]` is captured-but-empty; attachments aren't forwarded yet.

## Per-platform review (12 adapters)

A review of every adapter confirmed the inbound-normalization, mention-gating (entity/
mentioned-array, not substring), reply-to-bot-as-implicit-mention, token caching, and signature
schemes are aligned with each platform's documented behavior. Dedup is intentionally core-side
(`ChannelService.seen`), not per-adapter. Four issues were found and fixed:

- **WeCom decrypt (correctness bug):** WeCom pads PKCS7 to a **32-byte** block (pad can exceed 16), which
  Web Crypto's AES-CBC rejects. Switched `decryptWecom` to `node:crypto` + `setAutoPadding(false)` with
  manual strip, and added the `receive_id === corpId` anti-spoof check.
- **IRC outbound injection (security):** agent output is hostile — `sanitizeIrcText` strips CR/LF + control
  chars and `sanitizeIrcTarget` validates the target so a reply can't smuggle a raw IRC command.
- **Teams serviceUrl SSRF (security):** without inbound JWT validation a forged activity could point
  `serviceUrl` at an attacker host and leak the AAD token; `isAllowedTeamsServiceUrl` allowlists Bot
  Framework hosts before a serviceUrl is remembered.
- **Feishu signature (security):** verify `SHA256(timestamp+nonce+encryptKey+body)` on the raw body when an
  encrypt key is configured, and reject AES-`encrypt` payloads (disable encryption in the console) rather
  than mis-parsing them.

Accepted divergences (low value to change): Telegram `text_mention` entity unhandled; Slack
thread-reply not treated as implicit mention; outbound length uses hard platform caps (the core
`splitForLimit` already splits at boundaries) rather than headroom constants.

## How to extend the conformance suite

1. Derive the rule from the platform's documented behavior, and express it as an INPUT →
   expected-OUTPUT pair.
2. If it's adapter-level (platform payload → `ChannelInbound`), test `normalizeTelegramMessage`
   (or your adapter's pure normalizer) directly.
3. If it's core-level (routing/keying/auth/render), drive `ChannelService` with a mock adapter
   (see `coreHarness` in the test) or `createRenderer` with a capturing adapter.
