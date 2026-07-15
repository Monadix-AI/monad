// Layered memory (L1) — headless contracts + the pure security filter shared by every backend.
// Design A drives MemoryDir + the `memory` tool directly from the daemon service; this module now
// holds only the swappable-backend contract (mem0 implements it) and the sanitize/render helpers.
// See docs/internals/memory.md.

import type { L1Capabilities, MemoryBlock, MemoryConfigField, MemoryScope, RecallCtx, WriteCtx } from '@monad/protocol';

/** One conversational turn handed to the write path for fact extraction. */
export interface MemoryTurn {
  user: string;
  assistant: string;
}

export interface MemoryToolSchema {
  name: string;
  description: string;
  inputSchema: unknown;
}

/**
 * The single active L1 backend (a swappable, mutually-exclusive slot). `recall` is prefetch
 * (latency-aware), and `observe` is per-turn writeback (non-blocking).
 * Built-in memory is driven directly by the daemon service (design A); mem0 implements this contract.
 */
export interface L1Adapter {
  readonly name: string;
  isAvailable(): boolean;
  capabilities(): L1Capabilities;

  recall(ctx: RecallCtx): Promise<MemoryBlock>;
  observe(turn: MemoryTurn, ctx: WriteCtx): Promise<void>;

  toolSchemas(): MemoryToolSchema[];
  handleToolCall(name: string, args: unknown): Promise<string>;

  onSessionEnd?(scope: MemoryScope): Promise<void>;
  configSchema?(): MemoryConfigField[];
}

// ───────────────────────────────── pure security filter (zero I/O) ─────────────────────────────────

// Invisible/format Unicode that can hide injected instructions inside an otherwise-innocent fact:
// zero-width chars, bidi controls, BOM, word-joiner. Stripped before a fact reaches the prompt.
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁯﻿]/g;

// Secret-shaped substrings redacted at write time (never read time). Conservative, not exhaustive.
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9]{16,}/g, // OpenAI-style keys
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g, // PEM private keys
  /\b[A-Za-z0-9._%+-]+:[^\s@/]{6,}@/g // user:password@ in a URL
];

// A *fact* that issues instructions is almost certainly injection, not knowledge — reject outright.
const INJECTION = /\b(ignore|disregard|forget)\b[\s\S]{0,40}\b(previous|prior|above|earlier|all)\b/i;

export interface SanitizeResult {
  ok: boolean;
  cleaned: string;
  reason?: string;
}

/**
 * Treat a machine-extracted fact as hostile input before it enters the prompt or disk
 * (§ security-first). Strips invisible Unicode, redacts secrets at write time, and rejects
 * instruction-shaped (prompt-injection) content. Pure.
 */
export function sanitizeFact(raw: string): SanitizeResult {
  let s = raw.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  if (!s) return { ok: false, cleaned: '', reason: 'empty' };
  if (INJECTION.test(s)) return { ok: false, cleaned: '', reason: 'injection-shaped' };
  let redacted = false;
  for (const re of SECRET_PATTERNS) {
    if (re.test(s)) {
      redacted = true;
      s = s.replace(re, '[redacted]');
    }
  }
  const stripped = s
    .replace(/\[redacted\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // A fact that is *only* a redacted secret carries no knowledge — drop it.
  if (redacted && stripped.length < 3) return { ok: false, cleaned: '', reason: 'secret-only' };
  return { ok: true, cleaned: s };
}
