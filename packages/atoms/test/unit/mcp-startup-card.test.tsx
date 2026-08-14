import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { siModelcontextprotocol } from 'simple-icons';

import { ObservationToolCardShell } from '../../src/workplace-experiences/chat-room/components/observation/card-shell.tsx';
import {
  createObservationDisclosureStore,
  ObservationDisclosureProvider,
  ObservationDisclosureScope
} from '../../src/workplace-experiences/chat-room/components/observation/disclosure.tsx';
import {
  McpStartupProgressCard,
  mcpStartupView
} from '../../src/workplace-experiences/chat-room/components/observation/mcp-startup-progress.tsx';

const bootPayload = {
  active: 'codex_apps',
  failed: 1,
  pending: 1,
  ready: 3,
  servers: [
    { name: 'monad', status: 'ready' },
    { name: 'codegraph', status: 'ready' },
    { name: 'node_repl', status: 'ready' },
    {
      error: 'MCP client for `shadcn` failed to start: connection closed: initialize response',
      failureReason: 'reauthenticationRequired',
      name: 'shadcn',
      status: 'failed'
    },
    { name: 'codex_apps', status: 'starting' }
  ],
  total: 5
};

function plainText(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function renderCard(payload: Record<string, unknown>, expanded = false): { expanded: boolean; markup: string } {
  const store = createObservationDisclosureStore();
  store.write('startup/card', expanded);
  const markup = renderToStaticMarkup(
    <ObservationDisclosureProvider store={store}>
      <ObservationDisclosureScope id="startup">
        <McpStartupProgressCard
          provider="codex"
          view={mcpStartupView(payload)}
        />
      </ObservationDisclosureScope>
    </ObservationDisclosureProvider>
  );
  return { expanded: /<details[^>]*\sopen=""/.test(markup), markup };
}

function cardTitle(payload: Record<string, unknown>, expanded = false): string {
  const { markup } = renderCard(payload, expanded);
  return plainText(markup.slice(markup.indexOf('<summary'), markup.indexOf('</summary>')));
}

function titleMarkup(payload: Record<string, unknown>): string {
  const { markup } = renderCard(payload);
  return markup.slice(markup.indexOf('<summary'), markup.indexOf('</summary>'));
}

function genericMcpTitleMarkup(): string {
  const store = createObservationDisclosureStore();
  const markup = renderToStaticMarkup(
    <ObservationDisclosureProvider store={store}>
      <ObservationDisclosureScope id="generic-mcp">
        <ObservationToolCardShell
          header="Monad MCP"
          kind="mcp"
          status="success"
        >
          <span>complete</span>
        </ObservationToolCardShell>
      </ObservationDisclosureScope>
    </ObservationDisclosureProvider>
  );
  return markup.slice(markup.indexOf('<summary'), markup.indexOf('</summary>'));
}

test('the collapsed Codex startup card reports boot progress in a closed disclosure', () => {
  const collapsed = renderCard(bootPayload);
  expect({ expanded: collapsed.expanded, title: cardTitle(bootPayload) }).toEqual({
    expanded: false,
    title: 'Starting MCP servers (3/5): codex_apps 0s'
  });
});

test('running and settled MCP startup titles keep the same MCP icon', () => {
  const genericMcp = genericMcpTitleMarkup();
  const running = titleMarkup(bootPayload);
  const settled = titleMarkup({
    ...bootPayload,
    active: undefined,
    pending: 0,
    ready: 4
  });
  const icon = (markup: string) => markup.match(/<svg[^>]*>[\s\S]*?<\/svg>/)?.[0];

  expect({
    genericMcpUsesOfficialIcon: genericMcp.includes(`d="${siModelcontextprotocol.path}"`),
    officialMcpIcon: running.includes(`d="${siModelcontextprotocol.path}"`),
    runningHasOrb: running.includes('data-slot="observation-tool-orb"'),
    sameIcon: icon(running) === icon(settled),
    settledHasOrb: settled.includes('data-slot="observation-tool-orb"')
  }).toEqual({
    genericMcpUsesOfficialIcon: false,
    officialMcpIcon: true,
    runningHasOrb: false,
    sameIcon: true,
    settledHasOrb: false
  });
});

test('expanding the Codex startup card opens it onto every server and the failure detail', () => {
  const opened = renderCard(bootPayload, true);
  expect({ expanded: opened.expanded, text: plainText(opened.markup) }).toEqual({
    expanded: true,
    text:
      'Starting MCP servers (3/5): codex_apps 0s monad ready codegraph ready node_repl ready shadcn failed ' +
      'MCP client for `shadcn` failed to start: connection closed: initialize response codex_apps starting'
  });
});

test('a settled Codex startup card summarizes the failed servers', () => {
  expect(
    cardTitle({
      failed: 1,
      pending: 0,
      ready: 4,
      servers: bootPayload.servers.map((server) =>
        server.status === 'starting' ? { ...server, status: 'ready' } : server
      ),
      total: 5
    })
  ).toBe('MCP servers ready (4/5), 1 failed');
});

test('the shared startup card renders Claude connected and needs-auth statuses', () => {
  expect(
    cardTitle(
      {
        failed: 2,
        pending: 0,
        ready: 1,
        servers: [
          { name: 'monad', status: 'connected' },
          { name: 'shadcn', status: 'failed' },
          { name: 'claude.ai Notion', status: 'needs-auth' }
        ],
        total: 3
      },
      true
    )
  ).toBe('MCP servers ready (1/3), 2 failed');
});

test('a cancelled boot settles the card instead of running its duration forever', () => {
  expect(
    cardTitle({
      failed: 0,
      pending: 0,
      ready: 0,
      servers: [
        { name: 'monad', status: 'cancelled' },
        { name: 'codex_apps', status: 'cancelled' }
      ],
      skipped: 2,
      total: 2
    })
  ).toBe('MCP servers ready (0/2), 2 canceled');
});
