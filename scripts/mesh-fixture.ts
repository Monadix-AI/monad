/**
 * Turn a mesh observation capture into a sanitized fixture.
 *
 * Independent of how the input was produced. The daemon's developer-mode tap writes captures
 * verbatim (apps/monad/src/services/mesh-agent/fixture-tap.ts), but any file of the same shape — or
 * a plain provider `.jsonl` — works. Placing the result anywhere is the caller's business.
 *
 *   bun scripts/mesh-fixture.ts <input> <output.raw.json> [--provider codex]
 *
 * Input is either a capture object (`{ provider, page: { records: [{ data }] } }`) or newline-
 * delimited provider records, in which case `--provider` names the source.
 */
import type { MeshAgentProvider, MeshRawEventPage, MeshRawEventRecord } from '../packages/protocol/src/index.ts';

import { parseJsonlFrames } from '../packages/atoms/src/agent-adapters/observation-fixture.ts';
import {
  sanitizeObservationRecords,
  unsanitizedSemanticStrings
} from '../packages/atoms/src/agent-adapters/observation-sanitize.ts';

interface Capture {
  provider: MeshAgentProvider;
  page: MeshRawEventPage;
}

function fail(message: string): never {
  process.stderr.write(`[mesh-fixture] ${message}\n`);
  process.exit(2);
}

const [input, output, ...flags] = process.argv.slice(2);
if (!input || !output) {
  fail('usage: bun scripts/mesh-fixture.ts <input> <output.raw.json> [--provider <name>]');
}

const providerFlag = flags.indexOf('--provider');
const providerOverride = providerFlag >= 0 ? flags[providerFlag + 1] : undefined;
if (providerFlag >= 0 && !providerOverride) fail('--provider requires a name');

const text = await Bun.file(input)
  .text()
  .catch(() => fail(`cannot read ${input}`));

function readCapture(): Capture {
  try {
    const parsed = JSON.parse(text) as Partial<Capture>;
    if (parsed?.page && Array.isArray(parsed.page.records)) {
      const provider = (providerOverride ?? parsed.provider) as MeshAgentProvider | undefined;
      if (!provider) fail('capture has no provider; pass --provider');
      return { provider, page: { records: parsed.page.records, coverage: parsed.page.coverage ?? 'settled' } };
    }
  } catch {
    // Not a capture object — fall through to the newline-delimited provider-record form.
  }
  const records = parseJsonlFrames(text);
  if (records.length === 0) fail(`${input} contains no provider records`);
  if (!providerOverride) fail('newline-delimited input needs --provider');
  return {
    provider: providerOverride as MeshAgentProvider,
    page: { records: records.map((data) => ({ data })), coverage: 'settled' }
  };
}

const capture = readCapture();
const records = sanitizeObservationRecords(capture.page.records) as MeshRawEventRecord[];
const fixture: Capture = { provider: capture.provider, page: { records, coverage: capture.page.coverage } };

const leaks = unsanitizedSemanticStrings(fixture);
if (leaks.length > 0) {
  process.stderr.write(`[mesh-fixture] refusing to write: ${leaks.length} value(s) survived redaction\n`);
  for (const leak of leaks.slice(0, 10)) process.stderr.write(`  ${leak}\n`);
  process.exit(1);
}

await Bun.write(output, `${JSON.stringify(fixture, null, 2)}\n`);
process.stdout.write(`[mesh-fixture] wrote ${output} (${records.length} records, ${capture.provider})\n`);
