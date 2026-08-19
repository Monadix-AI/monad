/**
 * Turn mesh observation captures into sanitized fixtures.
 *
 * Single capture:
 *   bun scripts/mesh-fixture.ts <input> <output.raw.json> [--provider codex]
 *
 * Reviewed multi-turn capture:
 *   bun scripts/mesh-fixture.ts inspect --provider codex --manifest /tmp/boundaries.json <capture...>
 *   bun scripts/mesh-fixture.ts build --manifest /tmp/boundaries.json --output fixture.raw.json <capture...>
 */
import type { MeshAgentProvider, MeshRawEventPage, MeshRawEventRecord } from '../packages/protocol/src/index.ts';

import { createHash, randomUUID } from 'node:crypto';
import { rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import {
  multiTurnObservationFixtureSchema,
  parseJsonlFrames
} from '../packages/atoms/src/agent-adapters/fixtures/observation-fixture.ts';
import {
  ObservationSanitizer,
  sanitizeObservationRecords,
  unsanitizedSemanticStrings
} from '../packages/atoms/src/agent-adapters/fixtures/observation-sanitize.ts';
import { builtinAgentAdapters } from '../packages/atoms/src/agent-adapters/index.ts';
import {
  approvalsFileSchema,
  meshAgentProviderSchema,
  meshRawEventPageSchema,
  offsetPaginationResponseSchema
} from '../packages/protocol/src/index.ts';

interface Capture {
  provider: MeshAgentProvider;
  page: MeshRawEventPage;
}

interface LoadedSource {
  basename: string;
  bytes: number;
  sha256: string;
  mtimeMs: number;
  records: unknown[];
}

const emptyStrictObjectSchema = meshRawEventPageSchema.pick({}).strict();
const nonnegativeIntegerSchema = offsetPaginationResponseSchema.shape.total;
const positiveIntegerSchema = offsetPaginationResponseSchema.shape.limit;
const sourceBindingSchema = emptyStrictObjectSchema.extend({
  basename: meshAgentProviderSchema,
  bytes: nonnegativeIntegerSchema,
  sha256: meshAgentProviderSchema.refine((value) => /^[0-9a-f]{64}$/.test(value))
});
const reviewedTurnSpanSchema = emptyStrictObjectSchema.extend({
  startRecord: nonnegativeIntegerSchema,
  endRecordExclusive: positiveIntegerSchema
});
const multiTurnFixtureManifestSchema = emptyStrictObjectSchema
  .extend({
    version: approvalsFileSchema.shape.version,
    provider: meshAgentProviderSchema,
    sources: sourceBindingSchema.array().min(1),
    turns: reviewedTurnSpanSchema.array().min(1)
  })
  .strict();

type MultiTurnFixtureManifest = ReturnType<typeof multiTurnFixtureManifestSchema.parse>;

const MAX_FORMATTED_FIXTURE_BYTES = 1_048_576;

function fail(message: string): never {
  process.stderr.write(`[mesh-fixture] ${message}\n`);
  process.exit(2);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) fail(`${name} requires a value`);
  args.splice(index, 2);
  if (args.includes(name)) fail(`${name} may be passed only once`);
  return value;
}

function captureFilenameMetadata(name: string): { provider: string; meshSessionId: string } | undefined {
  const match = name.match(/^(.+)-(mesh_[0-9A-Za-z]{12})-(.+)\.jsonl$/);
  return match?.[1] && match[2] ? { provider: match[1], meshSessionId: match[2] } : undefined;
}

function validateCaptureSet(sources: readonly LoadedSource[], provider: string): void {
  const names = new Set(sources.map((source) => source.basename));
  if (names.size !== sources.length) fail('source basenames must be unique');

  const metadata = sources.map((source) => captureFilenameMetadata(source.basename));
  if (metadata.some((item) => item === undefined))
    fail('every source basename must match the canonical MeshFixtureTap capture name');

  const present = metadata.filter((item): item is NonNullable<typeof item> => item !== undefined);
  const providers = new Set(present.map((item) => item.provider));
  if (providers.size !== 1 || !providers.has(provider)) fail('mixed providers do not match the selected provider');
  if (new Set(present.map((item) => item.meshSessionId)).size !== 1) fail('mixed mesh session IDs are not allowed');
}

function parseCompleteJsonl(text: string, sourceName: string): unknown[] {
  const lastBreak = text.lastIndexOf('\n');
  if (lastBreak < 0) return [];
  const complete = text.slice(0, lastBreak);
  const records: unknown[] = [];
  for (const [index, line] of complete.split('\n').entries()) {
    if (!line.trim()) continue;
    const parsed = parseJsonlFrames(`${line}\n`);
    if (parsed.length !== 1) fail(`${sourceName}: invalid JSONL at line ${index + 1}`);
    records.push(parsed[0]);
  }
  return records;
}

async function loadSource(path: string): Promise<LoadedSource> {
  const name = basename(path);
  const [buffer, metadata] = await Promise.all([
    Bun.file(path)
      .arrayBuffer()
      .catch(() => fail(`cannot read ${name}`)),
    stat(path).catch(() => fail(`cannot stat ${name}`))
  ]);
  const bytes = new Uint8Array(buffer);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const records = parseCompleteJsonl(new TextDecoder().decode(bytes), name);
  if (records.length === 0) fail(`${name} contains no complete provider records`);
  return { basename: name, bytes: bytes.byteLength, sha256, mtimeMs: metadata.mtimeMs, records };
}

async function loadSources(paths: readonly string[]): Promise<LoadedSource[]> {
  if (paths.length === 0) fail('at least one explicit capture path is required');
  const sources = await Promise.all(paths.map(loadSource));
  return sources.sort((left, right) => left.mtimeMs - right.mtimeMs || left.basename.localeCompare(right.basename));
}

function projectorSuggestedSpans(provider: MeshAgentProvider, records: readonly unknown[]) {
  const adapter = builtinAgentAdapters.find((candidate) => candidate.provider === provider);
  const projector = adapter?.events?.createLiveProjector?.({ id: 'fixture-inspection' });
  const classify = adapter?.observation?.classifyActivity;
  if (!projector || !classify) fail(`provider ${provider} has no observation projector for boundary suggestions`);

  const terminalIds = new Set<string>();
  const turns: Array<{ startRecord: number; endRecordExclusive: number }> = [];
  let startRecord = 0;
  for (const [index, record] of records.entries()) {
    const events = projector.advance(`${JSON.stringify(record)}\n`).events;
    const discovered = events.filter((event) => classify(event) === 'turn-end' && !terminalIds.has(event.id));
    for (const event of discovered) terminalIds.add(event.id);
    if (discovered.length === 0) continue;
    turns.push({ startRecord, endRecordExclusive: index + 1 });
    startRecord = index + 1;
  }
  return turns;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isNativeCompleteTurnEnd(provider: string, value: unknown): boolean {
  const record = recordValue(value);
  if (!record) return false;
  if (provider === 'claude-code') return record.type === 'result';
  if (provider !== 'codex') return false;
  if (record.method === 'turn/completed' || record.type === 'turn.completed' || record.type === 'result') return true;
  const payload = recordValue(record.payload);
  return record.type === 'event_msg' && payload?.type === 'task_complete';
}

function validateSpans(manifest: MultiTurnFixtureManifest, records: readonly unknown[]): void {
  let previousEnd = 0;
  for (const [index, turn] of manifest.turns.entries()) {
    if (turn.startRecord >= turn.endRecordExclusive || turn.endRecordExclusive > records.length)
      fail(`turn ${index + 1} is out of bounds`);
    if (turn.startRecord < previousEnd) fail(`turn ${index + 1} overlaps the previous span`);
    if (!isNativeCompleteTurnEnd(manifest.provider, records[turn.endRecordExclusive - 1]))
      fail(`turn ${index + 1} does not end at a native complete-turn endpoint`);
    previousEnd = turn.endRecordExclusive;
  }
}

async function readManifest(path: string): Promise<MultiTurnFixtureManifest> {
  const name = basename(path);
  const text = await Bun.file(path)
    .text()
    .catch(() => fail(`cannot read manifest ${name}`));
  try {
    return multiTurnFixtureManifestSchema.parse(JSON.parse(text));
  } catch {
    fail(`invalid manifest ${name}`);
  }
}

function verifySourceBindings(manifest: MultiTurnFixtureManifest, sources: readonly LoadedSource[]): void {
  const actual = sources.map((source) => ({
    basename: source.basename,
    bytes: source.bytes,
    sha256: source.sha256
  }));
  if (JSON.stringify(actual) !== JSON.stringify(manifest.sources))
    fail('source binding mismatch; inspect and review again');
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const name = basename(path);
  const temporary = join(dirname(path), `.${name}.${randomUUID()}.tmp`);
  try {
    await Bun.write(temporary, contents);
    await rename(temporary, path);
  } catch {
    await unlink(temporary).catch(() => undefined);
    fail(`cannot write ${name}`);
  }
}

async function inspectMode(rawArgs: readonly string[]): Promise<void> {
  const args = [...rawArgs];
  const providerValue = option(args, '--provider');
  const manifestPath = option(args, '--manifest');
  if (!providerValue) fail('inspect requires --provider');
  if (!manifestPath) fail('inspect requires --manifest');
  if (args.some((arg) => arg.startsWith('--'))) fail('inspect received an unknown option');
  const provider = meshAgentProviderSchema.parse(providerValue);
  const sources = await loadSources(args);
  validateCaptureSet(sources, provider);
  const records = sources.flatMap((source) => source.records);
  const turns = projectorSuggestedSpans(provider, records);
  if (turns.length === 0) fail('projector suggested no complete turn spans');
  const manifest = multiTurnFixtureManifestSchema.parse({
    version: 1,
    provider,
    sources: sources.map((source) => ({
      basename: source.basename,
      bytes: source.bytes,
      sha256: source.sha256
    })),
    turns
  });
  await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  for (const source of sources)
    process.stdout.write(
      `[mesh-fixture] ${source.basename}: ${source.records.length} records, ${source.bytes} bytes, sha256 ${source.sha256}\n`
    );
  process.stdout.write(
    `[mesh-fixture] wrote ${basename(manifestPath)} with suggested spans ${turns
      .map((turn) => `${turn.startRecord}:${turn.endRecordExclusive}`)
      .join(', ')}\n`
  );
}

async function buildMode(rawArgs: readonly string[]): Promise<void> {
  const args = [...rawArgs];
  const manifestPath = option(args, '--manifest');
  const output = option(args, '--output');
  if (!manifestPath) fail('build requires --manifest');
  if (!output) fail('build requires --output');
  if (args.some((arg) => arg.startsWith('--'))) fail('build received an unknown option');
  const [manifest, sources] = await Promise.all([readManifest(manifestPath), loadSources(args)]);
  verifySourceBindings(manifest, sources);
  validateCaptureSet(sources, manifest.provider);
  const records = sources.flatMap((source) => source.records);
  validateSpans(manifest, records);

  const sanitizer = new ObservationSanitizer();
  const sanitized = records.map((record) => sanitizer.sanitize(record));
  const fixture = multiTurnObservationFixtureSchema.parse({
    provider: manifest.provider,
    turns: manifest.turns.map((turn) => ({
      records: sanitized.slice(turn.startRecord, turn.endRecordExclusive).map((data) => ({ data })),
      coverage: 'settled'
    }))
  });
  const leaks = unsanitizedSemanticStrings(fixture);
  if (leaks.length > 0) fail(`sanitization left ${leaks.length} semantic value(s)`);
  const formatted = `${JSON.stringify(fixture, null, 2)}\n`;
  const formattedBytes = Buffer.byteLength(formatted);
  if (formattedBytes > MAX_FORMATTED_FIXTURE_BYTES)
    fail(`formatted fixture is ${formattedBytes} bytes; the limit is 1 MiB`);
  await atomicWrite(output, formatted);
  process.stdout.write(
    `[mesh-fixture] wrote ${basename(output)} (${manifest.turns.length} turns, ${records.length} source records, ${manifest.provider})\n`
  );
}

async function legacyMode(rawArgs: readonly string[]): Promise<void> {
  const [input, output, ...flags] = rawArgs;
  if (!input || !output) fail('usage: bun scripts/mesh-fixture.ts <input> <output.raw.json> [--provider <name>]');
  const inputPath = input;
  const outputPath = output;
  const providerFlag = flags.indexOf('--provider');
  const providerOverride = providerFlag >= 0 ? flags[providerFlag + 1] : undefined;
  if (providerFlag >= 0 && !providerOverride) fail('--provider requires a name');

  const text = await Bun.file(inputPath)
    .text()
    .catch(() => fail(`cannot read ${basename(inputPath)}`));

  function readCapture(): Capture {
    try {
      const parsed = JSON.parse(text) as Partial<Capture>;
      if (parsed?.page && Array.isArray(parsed.page.records)) {
        const provider = (providerOverride ?? parsed.provider) as MeshAgentProvider | undefined;
        if (!provider) fail('capture has no provider; pass --provider');
        return { provider, page: { records: parsed.page.records, coverage: parsed.page.coverage ?? 'settled' } };
      }
    } catch {
      // The legacy input may be a capture object or provider JSONL.
    }
    const records = parseJsonlFrames(text);
    if (records.length === 0) fail(`${basename(inputPath)} contains no provider records`);
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
  if (leaks.length > 0) fail(`sanitization left ${leaks.length} semantic value(s)`);
  await atomicWrite(outputPath, `${JSON.stringify(fixture, null, 2)}\n`);
  process.stdout.write(
    `[mesh-fixture] wrote ${basename(outputPath)} (${records.length} records, ${capture.provider})\n`
  );
}

const [mode, ...args] = process.argv.slice(2);
if (mode === 'inspect') await inspectMode(args);
else if (mode === 'build') await buildMode(args);
else await legacyMode(process.argv.slice(2));
