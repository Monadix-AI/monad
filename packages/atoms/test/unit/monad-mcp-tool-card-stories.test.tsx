import { expect, test } from 'bun:test';
import { renderToStaticMarkup as renderReactToStaticMarkup } from 'react-dom/server';

import { MONAD_MCP_TOOL_NAMES } from '../../src/workplace-experiences/chat-room/components/observation/monad-mcp-projection.ts';
import { WorkplaceExperienceHostProvider } from '../../src/workplace-experiences/host-context.tsx';
import {
  AllMonadMcpToolStoryCards,
  MONAD_MCP_STORY_VIEWS,
  MonadMcpToolStoryCard
} from '../../stories/monad-mcp-tool-card-story-fixtures.tsx';

function renderToStaticMarkup(node: React.ReactNode): string {
  return renderReactToStaticMarkup(
    <WorkplaceExperienceHostProvider
      value={{
        openStudio: () => {},
        requestProjectDialog: () => {},
        resolveAgentIdentity: (reference) => ({
          id: reference.id ?? reference.name ?? 'agent',
          name: 'Claude Code',
          providerIcon: { path: 'M2 2h20v20H2z', title: 'Claude Code' }
        })
      }}
    >
      {node}
    </WorkplaceExperienceHostProvider>
  );
}

test('the Monad MCP Storybook catalog renders every supported semantic tool card expanded', () => {
  const markup = renderToStaticMarkup(<AllMonadMcpToolStoryCards />);

  // behavior-ok: rendering the catalog produces one expanded semantic card and output for every supported tool.
  expect({
    cards: markup.match(/data-slot="observation-tool-card"/g)?.length,
    agentIdentities: markup.match(/data-slot="monad-mcp-agent-identity"/g)?.length,
    collapsedBodies: markup.match(/data-collapsed="true"/g)?.length,
    expanded: markup.match(/<details[^>]* open=""/g)?.length,
    inboxes: markup.match(/data-slot="monad-mcp-inbox"/g)?.length,
    messageLists: markup.match(/data-slot="monad-mcp-message-list"/g)?.length,
    members: markup.match(/data-slot="monad-mcp-members"/g)?.length,
    outputs: markup.match(/data-slot="monad-mcp-output"/g)?.length,
    plans: markup.match(/data-slot="monad-mcp-plan"/g)?.length,
    questions: markup.match(/data-slot="monad-mcp-question"/g)?.length,
    receipts: markup.match(/data-slot="monad-mcp-receipt"/g)?.length,
    runtimes: markup.match(/data-slot="monad-mcp-runtime"/g)?.length,
    storyTools: Object.keys(MONAD_MCP_STORY_VIEWS)
  }).toEqual({
    cards: MONAD_MCP_TOOL_NAMES.length,
    agentIdentities: 6,
    collapsedBodies: 2,
    expanded: MONAD_MCP_TOOL_NAMES.length,
    inboxes: 2,
    messageLists: 1,
    members: 1,
    outputs: MONAD_MCP_TOOL_NAMES.length - 1,
    plans: 4,
    questions: 1,
    receipts: 4,
    runtimes: 1,
    storyTools: [...MONAD_MCP_TOOL_NAMES]
  });
});

test('the private-message title keeps the recipient name and host provider icon inside the title', () => {
  const markup = renderToStaticMarkup(<MonadMcpToolStoryCard toolName="agent_send" />);

  // behavior-ok: rendering a known recipient produces one compound title with its avatar, name, and provider icon.
  expect({
    compoundTitle:
      /data-slot="observation-meta-title"[\s\S]*data-slot="monad-mcp-recipient"[\s\S]*data-slot="monad-mcp-agent-identity"/.test(
        markup
      ),
    providerIcon: markup.includes('aria-label="Claude Code"'),
    recipientName: markup.includes('title="Claude Code"')
  }).toEqual({ compoundTitle: true, providerIcon: true, recipientName: true });
});
