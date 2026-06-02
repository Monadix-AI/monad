# Channel conformance (vs hermes / OpenClaw)

We can't develop against every third-party IM platform, so we treat the **hermes-agent** and
**OpenClaw** channel adapters as bug-free behavioral oracles and pin our system's behavior to theirs
where they agree. This is the conformance contract; the tests live in
`apps/monad/test/unit/channel-conformance.test.ts` (+ `telegram` normalization is a pure, tested
function `normalizeTelegramMessage`).

## Shared contracts we MATCH

| # | Behavior | Reference rule (both agree) | Our implementation | Test |
|---|---|---|---|---|
| A1 | Text source | `text` XOR `caption`, never concatenated; media-only → media kind | `normalizeTelegramMessage` | A1 |
| A2 | Command parse | strip leading `/`, strip `@suffix`, **lowercase**; args follow | `normalizeTelegramMessage` (we added lowercasing) | A2 |
| A3 | Self/echo | drop messages from the bot's own id | `isSelf` + core echo guard | A3, C-self |
| A8 | Dedup | suppress a re-delivered message by its native id | core LRU on `nativeMessageId` | C-A8 |
| B9 | DM keying | one session per (channel, chatId) | `deriveKey` per-conversation | C-B9 |
| C11 | **Length limit** | split long replies at the platform char limit | `splitForLimit` in `render.ts` (we added this) | B-split, B-render |
| E18 | Disallowed user | **SILENT drop** — no "denied" reply, no session | core allowlist drop | C-E18 |
| D16 | Long-poll | advance offset = `update_id + 1`; reconnect w/ backoff | `telegram.ts` poll loop | smoke |
| F1 | **DM access policy** | OpenClaw `dmPolicy`: pairing / allowlist / open / disabled | `allowlist.policy` + core `accessDecision` | access:* |
| F2 | **Pairing flow** | OpenClaw: unknown DM sender → one-time code, operator approves | core `issuePairing` / `consumePairing` + `POST /channels/:id/pair` | pairing:* |
| F3 | **Group require-mention** | both: answer in a group only when @mentioned/replied-to | `groupPolicy.requireMention` + core group gate | group gate:* |
| F4 | **Per-channel agent hint** | hermes `platform_hint` | `agentHint` → `origin.ext` → `ambientContext` | agentHint:* |

Conformance gaps **we fixed in this pass**: command lowercasing (`/NEW` == `/new`), outbound
chunking at `maxMessageChars`, the OpenClaw-style **DM access policy + pairing flow**, the
**group require-mention gate**, and hermes' **per-channel agent hint**. We also grew from one channel
(Telegram) to four reference adapters spanning all three inbound styles — long-poll (Telegram),
dial-out WebSocket (Discord Gateway, Slack Socket Mode), and inbound webhook.

## Documented divergences (hermes ≠ OpenClaw → we pick a stance)

| Behavior | hermes | OpenClaw | Our stance |
|---|---|---|---|
| `@suffix` in commands | strips ANY `@x` | strips only when `@x` == bot username | **hermes** — strip any `@x` (simpler; bots don't see other-bot commands anyway) |
| Command namespace | any `/word` is a command | only a registered alias set | **hybrid** — adapter marks any `/word` as `kind:command`; the CORE only acts on known commands (`/new /switch /sessions /end`), unknown → treated as normal text (observably matches hermes' `/path/to/file` → not executed) |
| Group per-user isolation | per-user by default (`group_sessions_per_user`) | chat/topic-scoped (shared) | **configurable** — `mapping.granularity`: `per-conversation` (default, = OpenClaw) or `per-user` (= hermes) |
| Edited messages | hermes drops; OpenClaw records for reply-chain, no new turn | — | **drop** — we subscribe to `message` only (no `edited_message`); observably "not answered", same as both |
| Default DM gate | env-enable / open-ish | `pairing` (one-time code) | **`allowlist` default-deny** — pairing is opt-in via `allowlist.policy: 'pairing'` (we keep deny-by-default as the safe baseline, then offer OpenClaw's pairing UX on top) |

## Deliberately NOT matched (out of scope / by design)

- **Markdown**: our Telegram adapter sends plain text (`markdown:false`) to avoid MarkdownV2 parse
  failures; references do MarkdownV2/blocks. (We chose robustness over rich formatting for v1.)
  (Discord/Slack adapters set their own `markdown` capability.)
- **Progressive-edit throttle constants**: we throttle edits at ~1.2s; the references use
  platform-specific batch delays. Same shape, different constants.
- **Media passthrough**: `media[]` is captured-but-empty; attachments aren't forwarded yet.

## Per-platform source audit (12 adapters vs hermes/openclaw)

A line-by-line audit of every adapter against the competitors' real source (hermes `gateway/platforms/*`,
openclaw `extensions/<platform>/src/*`) confirmed the inbound-normalization, mention-gating (entity/
mentioned-array, not substring), reply-to-bot-as-implicit-mention, token caching, and signature schemes
are aligned. Dedup is intentionally core-side (`ChannelService.seen`), not per-adapter. Four real issues
were found and fixed:

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

Accepted divergences (parity with at least one oracle, low value to change): Telegram `text_mention`
entity unhandled; Slack thread-reply not treated as implicit mention; outbound length uses hard platform
caps (the core `splitForLimit` already splits at boundaries) rather than headroom constants.

## How to extend the conformance suite

1. Read the reference rule (file:line) in hermes `gateway/platforms/*` or OpenClaw `extensions/*`.
2. Express it as an INPUT → expected-OUTPUT pair.
3. If it's adapter-level (platform payload → `ChannelInbound`), test `normalizeTelegramMessage`
   (or your adapter's pure normalizer) directly.
4. If it's core-level (routing/keying/auth/render), drive `ChannelService` with a mock adapter
   (see `coreHarness` in the test) or `createRenderer` with a capturing adapter.
