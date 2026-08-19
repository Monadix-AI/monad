import { expect, test } from 'bun:test';

import { observationFixtureSchema } from '../../src/agent-adapters/fixtures/observation-fixture.ts';
import { unsanitizedSemanticStrings } from '../../src/agent-adapters/fixtures/observation-sanitize.ts';
import { builtinAgentAdapters } from '../../src/agent-adapters/index.ts';

test('captured Codex app-server live frames project complete lifecycle messages and indexed reasoning', async () => {
  const item = observationFixtureSchema.parse(
    await Bun.file(new URL('../fixtures/mesh-agent-observation/codex-app-server-live.raw.json', import.meta.url)).json()
  );
  const records = item.page.records.map((record) => record.data);
  const adapter = builtinAgentAdapters.find((candidate) => candidate.provider === 'codex');
  if (!adapter?.events) throw new Error('Codex event source is required');
  const events = adapter.events.projectLive({
    id: 'fixture-codex-live',
    output: records.map((record) => JSON.stringify(record)).join('\n'),
    mode: 'events'
  }).events;
  const messages = events.filter(
    (event) => event.providerEventType === 'item/agentMessage' || event.providerEventType === 'item/userMessage'
  );
  const reasoning = events.filter((event) => event.providerEventType?.startsWith('item/reasoning'));

  expect({
    coverage: item.page.coverage,
    records: records.length,
    unsafe: unsanitizedSemanticStrings(item),
    messages: messages.map(({ role, text }) => ({ role, text })),
    uniqueMessageKeys: new Set(messages.map((event) => event.dedupeKey)).size,
    reasoning: reasoning.map(({ providerEventType, summary, text }) => ({ providerEventType, summary, text })),
    leakedStructureEvents: events
      .filter((event) => event.providerEventType === 'item/reasoning/summaryPartAdded')
      .map((event) => event.text)
  }).toEqual({
    coverage: 'exact',
    records: 410,
    unsafe: [],
    messages: [
      { role: 'user', text: '<text:51>' },
      { role: 'agent', text: '<text:108>' },
      { role: 'agent', text: '<text:175>' },
      { role: 'agent', text: '<text:229>' },
      { role: 'agent', text: '<text:250>' },
      { role: 'agent', text: '<text:270>' }
    ],
    uniqueMessageKeys: 6,
    reasoning: [
      { providerEventType: 'item/reasoning/completed', summary: undefined, text: '<text:52>\n\n<text:53>' },
      { providerEventType: 'item/reasoning/completed', summary: undefined, text: '<text:115>' },
      { providerEventType: 'item/reasoning/completed', summary: undefined, text: '<text:118>' },
      { providerEventType: 'item/reasoning/delta', summary: '<text:124>', text: 'Thinking…' },
      { providerEventType: 'item/reasoning/completed', summary: undefined, text: '<text:125>' },
      { providerEventType: 'item/reasoning/completed', summary: undefined, text: '<text:126>\n\n<text:127>' },
      { providerEventType: 'item/reasoning/completed', summary: undefined, text: '<text:129>' },
      {
        providerEventType: 'item/reasoning/completed',
        summary: undefined,
        text: '<text:178>\n\n<text:179>\n\n<text:180>'
      },
      { providerEventType: 'item/reasoning/completed', summary: undefined, text: '<text:181>' },
      { providerEventType: 'item/reasoning/completed', summary: undefined, text: 'Thinking…' },
      { providerEventType: 'item/reasoning/completed', summary: undefined, text: 'Thinking…' },
      { providerEventType: 'item/reasoning/completed', summary: undefined, text: 'Thinking…' }
    ],
    leakedStructureEvents: []
  });
});
