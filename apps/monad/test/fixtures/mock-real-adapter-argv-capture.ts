#!/usr/bin/env bun
// Shared mock CLI for the per-provider `allowAutopilot` end-to-end tests: run under each REAL
// provider adapter's own `buildLaunch` (codex/qwen/claude-code — no adapter is swapped or faked), so
// the argv this process actually receives reflects that adapter's own real skip-approval flag.
//
// The output file is found by scanning argv for a `--argv-out=<path>` marker (rather than a fixed
// position) because each adapter inserts its own flags at different points around the caller's args.
// Everything else in argv (minus the marker) is recorded verbatim — including whichever real flag
// (`--ask-for-approval never`, `--approval-mode=yolo`, `--dangerously-skip-permissions`) the adapter
// under test decided to add or omit.
import { writeFileSync } from 'node:fs';

const MARKER = '--argv-out=';
const args = process.argv.slice(2);
const marker = args.find((arg) => arg.startsWith(MARKER));
const outFile = marker?.slice(MARKER.length);
const recorded = args.filter((arg) => arg !== marker).join(' ');
if (outFile) writeFileSync(outFile, recorded);

// Codex app-server handshake: respond to `initialize` and `thread/start`/`thread/resume` so the
// host's app-server startup wait resolves. Ignored (harmless) by qwen/claude-code, which don't speak
// this protocol and never write JSON-RPC frames to this process's stdin.
process.stdin.on('data', (chunk) => {
  for (const line of chunk.toString().trim().split(/\n+/)) {
    if (!line) continue;
    let msg: { id?: unknown; method?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.method === 'initialize') {
      process.stdout.write(`${JSON.stringify({ id: msg.id, result: { userAgent: 'mock' } })}\n`);
      continue;
    }
    if (msg.method === 'initialized') continue;
    if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
      process.stdout.write(`${JSON.stringify({ id: msg.id, result: { thread: { id: 'mock-thread-1' } } })}\n`);
    }
  }
});

setInterval(() => {}, 1000);
