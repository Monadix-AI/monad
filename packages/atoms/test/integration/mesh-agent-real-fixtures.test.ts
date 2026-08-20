import { expect, test } from 'bun:test';

import {
  type MultiTurnObservationFixture,
  multiTurnObservationFixtureSchema,
  observationFixtureSchema
} from '../../src/agent-adapters/fixtures/observation-fixture.ts';
import {
  sanitizeObservationRecords,
  unsanitizedSemanticStrings
} from '../../src/agent-adapters/fixtures/observation-sanitize.ts';
import { builtinAgentAdapters } from '../../src/agent-adapters/index.ts';

async function fixture(provider: 'codex' | 'claude-code') {
  return observationFixtureSchema.parse(
    await Bun.file(new URL(`../fixtures/mesh-agent-observation/${provider}.raw.json`, import.meta.url)).json()
  );
}

async function multiTurnFixture(provider: 'codex' | 'claude-code') {
  return multiTurnObservationFixtureSchema.parse(
    await Bun.file(
      new URL(`../fixtures/mesh-agent-observation/${provider}-multi-turn.raw.json`, import.meta.url)
    ).json()
  );
}

function flattenedRecords(item: MultiTurnObservationFixture) {
  return item.turns.flatMap((turn) => turn.records);
}

function turnEndpoints(item: MultiTurnObservationFixture) {
  let endpoint = 0;
  return item.turns.map((turn) => (endpoint += turn.records.length));
}

function semanticLeakLocations(item: MultiTurnObservationFixture) {
  return item.turns.flatMap((turn, turnIndex) =>
    unsanitizedSemanticStrings(turn).map((entry) => {
      const separator = entry.indexOf('=');
      return {
        provider: item.provider,
        turn: turnIndex,
        fieldPath: separator < 0 ? '$' : entry.slice(0, separator)
      };
    })
  );
}

function resanitizesUnchanged(item: MultiTurnObservationFixture) {
  const records = flattenedRecords(item);
  return JSON.stringify(sanitizeObservationRecords(records)) === JSON.stringify(records);
}

function provenanceKey(provider: 'codex' | 'claude-code', value: unknown) {
  if (provider === 'codex' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const { type, ...params } = value as Record<string, unknown>;
    if (type === 'turn.started') return JSON.stringify({ method: 'turn/started', params });
    if (type === 'turn.completed') return JSON.stringify({ method: 'turn/completed', params });
  }
  return JSON.stringify(value);
}

function projectedMarkerPositions(
  provider: 'codex' | 'claude-code',
  item: MultiTurnObservationFixture,
  markerType: string
) {
  const records = flattenedRecords(item).map((record) => record.data);
  const markerEvents = project(provider, records).filter((event) => event.providerEventType === markerType);
  const recordKeys = records.map((record) => provenanceKey(provider, record));
  let previous = -1;
  return markerEvents.map((event) => {
    const key = provenanceKey(provider, event.provenance.rawEvents[0]);
    const relative = recordKeys.slice(previous + 1).indexOf(key);
    if (relative < 0) throw new Error(`missing ${provider} marker provenance in fixture records`);
    previous += relative + 1;
    return previous + 1;
  });
}

function projectedTurnBoundaries(provider: 'codex' | 'claude-code', item: MultiTurnObservationFixture) {
  return {
    starts: projectedMarkerPositions(provider, item, provider === 'codex' ? 'turn/started' : 'turn-start'),
    ends: projectedMarkerPositions(provider, item, provider === 'codex' ? 'turn/completed' : 'result')
  };
}

function fixtureTurnBoundaries(provider: 'codex' | 'claude-code', item: MultiTurnObservationFixture) {
  let previousEnd = 0;
  const starts: number[] = [];
  const ends: number[] = [];
  for (const [turnIndex, turn] of item.turns.entries()) {
    const startIndex = turn.records.findIndex((record) => {
      const data = record.data;
      if (data === null || typeof data !== 'object' || Array.isArray(data) || !('type' in data)) return false;
      return data.type === (provider === 'codex' ? 'turn.started' : 'user');
    });
    if (startIndex < 0) throw new Error(`missing ${provider} fixture start marker for turn ${turnIndex}`);
    starts.push(previousEnd + startIndex + 1);
    previousEnd += turn.records.length;
    ends.push(previousEnd);
  }
  return { starts, ends };
}

function moveBoundary(
  provider: 'codex' | 'claude-code',
  item: MultiTurnObservationFixture,
  boundary: 'start' | 'end'
): MultiTurnObservationFixture {
  return {
    ...item,
    turns: item.turns.map((turn, turnIndex) => {
      const index =
        boundary === 'end'
          ? turn.records.length - 1
          : turn.records.findIndex((record) => {
              const data = record.data;
              if (data === null || typeof data !== 'object' || Array.isArray(data) || !('type' in data)) return false;
              return data.type === (provider === 'codex' ? 'turn.started' : 'user');
            });
      const swapIndex = boundary === 'end' ? index - 1 : index + 1;
      const marker = turn.records[index];
      const neighbor = turn.records[swapIndex];
      if (!marker || !neighbor) throw new Error(`cannot move ${provider} ${boundary} marker for turn ${turnIndex}`);
      const records = [...turn.records];
      records[index] = neighbor;
      records[swapIndex] = marker;
      return { ...turn, records };
    })
  };
}

test('multi-turn fixtures preserve the reviewed provider and turn-page contracts', async () => {
  const fixtures = await Promise.all([multiTurnFixture('codex'), multiTurnFixture('claude-code')]);
  const expectedProviders = ['codex', 'claude-code'] as const;

  expect(
    fixtures.map((item, fixtureIndex) => ({
      providerMatches: item.provider === expectedProviders[fixtureIndex],
      turnCount: item.turns.length,
      recordCount: flattenedRecords(item).length,
      endPositions: turnEndpoints(item),
      withinByteCeiling: Buffer.byteLength(`${JSON.stringify(item, null, 2)}\n`) <= 1_048_576,
      turnShapeMatches: item.turns.every(
        (turn) => JSON.stringify(Object.keys(turn).sort()) === JSON.stringify(['coverage', 'records'])
      ),
      semanticLeakCount: semanticLeakLocations(item).length,
      resanitizesUnchanged: resanitizesUnchanged(item)
    }))
  ).toEqual([
    {
      providerMatches: true,
      turnCount: 4,
      recordCount: 438,
      endPositions: [312, 319, 431, 438],
      withinByteCeiling: true,
      turnShapeMatches: true,
      semanticLeakCount: 0,
      resanitizesUnchanged: true
    },
    {
      providerMatches: true,
      turnCount: 8,
      recordCount: 205,
      endPositions: [7, 39, 46, 72, 112, 140, 162, 205],
      withinByteCeiling: true,
      turnShapeMatches: true,
      semanticLeakCount: 0,
      resanitizesUnchanged: true
    }
  ]);
});

test('multi-turn fixture disk values require four strict raw-event pages', () => {
  const valid = {
    provider: 'codex',
    turns: Array.from({ length: 4 }, () => ({ records: [], coverage: 'settled' as const }))
  };
  const withNextCursor = {
    ...valid,
    turns: [{ ...valid.turns[0], nextCursor: 'next' }, ...valid.turns.slice(1)]
  };

  expect(multiTurnObservationFixtureSchema.parse(valid)).toEqual(valid);
  expect(() => multiTurnObservationFixtureSchema.parse(withNextCursor)).toThrow();
  expect(() => multiTurnObservationFixtureSchema.parse({ ...valid, turns: valid.turns.slice(0, 3) })).toThrow();
  expect(() => multiTurnObservationFixtureSchema.parse({ ...valid, unknown: true })).toThrow();
});

function project(provider: 'codex' | 'claude-code', records: unknown[]) {
  const adapter = builtinAgentAdapters.find((candidate) => candidate.provider === provider);
  if (!adapter?.events) throw new Error(`missing ${provider} event source`);
  return adapter.events.projectLive({
    id: `fixture-${provider}`,
    output: records.map((record) => JSON.stringify(record)).join('\n'),
    mode: 'events'
  }).events;
}

test('captured Codex and Claude raw-history fixtures are protocol-valid and contain no unsanitized semantic strings', async () => {
  const fixtures = await Promise.all([fixture('codex'), fixture('claude-code')]);

  expect(
    fixtures.map((item) => ({
      provider: item.provider,
      coverage: item.page.coverage,
      records: item.page.records.length,
      unsafe: unsanitizedSemanticStrings(item)
    }))
  ).toEqual([
    { provider: 'codex', coverage: 'settled', records: 24, unsafe: [] },
    { provider: 'claude-code', coverage: 'settled', records: 24, unsafe: [] }
  ]);
});

test('the shipped sanitizer reproduces every committed fixture unchanged', async () => {
  const fixtures = await Promise.all([fixture('codex'), fixture('claude-code')]);

  // The capture tap sanitizes with this same function before writing, so a fixture that does not
  // survive a re-run is one the tap could not have produced — the convention would have drifted
  // away from its only implementation.
  expect(fixtures.map((item) => sanitizeObservationRecords(item.page.records))).toEqual(
    fixtures.map((item) => item.page.records)
  );
});

test('captured Codex response items project reasoning and custom tool boundaries', async () => {
  const { page } = await fixture('codex');
  const wanted = new Set(['reasoning', 'custom_tool_call', 'custom_tool_call_output']);
  const records = page.records
    .map((record) => record.data)
    .filter((record) => {
      if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
      const payload = (record as Record<string, unknown>).payload;
      return (
        !!payload && typeof payload === 'object' && wanted.delete(String((payload as Record<string, unknown>).type))
      );
    });

  expect(
    project('codex', records).map(({ role, source, providerEventType, text }) => ({
      role,
      source,
      providerEventType,
      text
    }))
  ).toEqual([
    { role: 'agent', source: 'codex-exec', providerEventType: 'reasoning', text: 'Thinking…' },
    {
      role: 'tool',
      source: 'codex-exec',
      providerEventType: 'custom_tool_call',
      text: 'Tool call exec <text:4>'
    },
    {
      role: 'tool',
      source: 'codex-exec',
      providerEventType: 'custom_tool_call_output',
      text: '[{"type":"input_text","text":"<text:5>"},{"type":"input_text","text":"<text:6>"}]'
    }
  ]);
});

test('captured Claude records project user, thinking, tool, result, assistant, and system boundaries', async () => {
  const { page } = await fixture('claude-code');
  const wanted = new Set(['user', 'thinking', 'tool_use', 'tool_result', 'text', 'system']);
  const records = page.records
    .map((record) => record.data)
    .filter((record) => {
      if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
      const value = record as Record<string, unknown>;
      const message =
        value.message && typeof value.message === 'object' ? (value.message as Record<string, unknown>) : {};
      const content = Array.isArray(message.content) ? message.content[0] : undefined;
      const contentType =
        content && typeof content === 'object' ? (content as Record<string, unknown>).type : undefined;
      const boundary =
        value.type === 'system'
          ? 'system'
          : value.type === 'user' && contentType !== 'tool_result'
            ? 'user'
            : (contentType ?? value.type);
      return wanted.delete(String(boundary));
    });

  expect(
    project('claude-code', records).map(({ role, source, providerEventType, text }) => ({
      role,
      source,
      providerEventType,
      text
    }))
  ).toEqual([
    { role: 'system', source: 'claude-code-sdk', providerEventType: 'turn-start', text: 'Turn started' },
    { role: 'user', source: 'claude-code-sdk', providerEventType: 'user', text: '<text:1>' },
    { role: 'agent', source: 'claude-code-sdk', providerEventType: 'thinking', text: '<text:3>' },
    {
      role: 'tool',
      source: 'claude-code-sdk',
      providerEventType: 'tool_use',
      text: 'Tool call ToolSearch {"query":"<text:7>","max_results":5}'
    },
    { role: 'tool', source: 'claude-code-sdk', providerEventType: 'tool_result', text: '<text:8>' },
    { role: 'agent', source: 'claude-code-sdk', providerEventType: 'assistant', text: '<text:17>' },
    { role: 'system', source: 'unknown', providerEventType: 'system', text: 'system' }
  ]);
});

test('multi-turn projector boundaries match the reviewed turn-page endpoints', async () => {
  for (const provider of ['codex', 'claude-code'] as const) {
    const item = await multiTurnFixture(provider);
    const expected = fixtureTurnBoundaries(provider, item);

    expect(projectedTurnBoundaries(provider, item)).toEqual(expected);
    expect(projectedTurnBoundaries(provider, moveBoundary(provider, item, 'start')).starts).not.toEqual(
      expected.starts
    );
    expect(projectedTurnBoundaries(provider, moveBoundary(provider, item, 'end')).ends).not.toEqual(expected.ends);
  }
});

test('incremental projectors match whole projection at every multi-turn page boundary', async () => {
  for (const provider of ['codex', 'claude-code'] as const) {
    const item = await multiTurnFixture(provider);
    const adapter = builtinAgentAdapters.find((candidate) => candidate.provider === provider);
    if (!adapter?.events) throw new Error(`missing ${provider} event source`);
    const incremental = adapter.events.createLiveProjector?.({ id: `fixture-${provider}` });
    if (!incremental) throw new Error(`missing ${provider} incremental projector`);
    const prefix: unknown[] = [];
    let incrementalEvents: ReturnType<typeof incremental.advance>['events'] = [];

    for (const turn of item.turns) {
      const pageRecords = turn.records.map((record) => record.data);
      prefix.push(...pageRecords);
      incrementalEvents = incremental.advance(
        `${pageRecords.map((record) => JSON.stringify(record)).join('\n')}\n`
      ).events;
      const wholeEvents = adapter.events.projectLive({
        id: `fixture-${provider}`,
        output: prefix.map((item) => JSON.stringify(item)).join('\n')
      }).events;
      expect({
        equivalent: JSON.stringify(incrementalEvents) === JSON.stringify(wholeEvents),
        incrementalCount: incrementalEvents.length,
        wholeCount: wholeEvents.length
      }).toEqual({ equivalent: true, incrementalCount: wholeEvents.length, wholeCount: wholeEvents.length });
    }

    const finalEvents = adapter.events.projectLive({
      id: `fixture-${provider}`,
      output: flattenedRecords(item)
        .map((record) => JSON.stringify(record.data))
        .join('\n')
    }).events;
    expect({
      equivalent: JSON.stringify(incrementalEvents) === JSON.stringify(finalEvents),
      incrementalCount: incrementalEvents.length,
      wholeCount: finalEvents.length
    }).toEqual({ equivalent: true, incrementalCount: finalEvents.length, wholeCount: finalEvents.length });
  }
});
