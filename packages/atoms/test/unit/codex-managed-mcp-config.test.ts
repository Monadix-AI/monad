import { expect, test } from 'bun:test';

import { codexManagedMcpConfigArgs } from '../../src/agent-adapters/codex/launch.ts';

test('managed Codex pre-approves every Monad communication tool', () => {
  const args = codexManagedMcpConfigArgs({ command: 'monad', args: ['native-agent'] }, {});

  expect(args.filter((arg) => arg.startsWith('mcp_servers.monad.tools.'))).toEqual([
    'mcp_servers.monad.tools.project_post.approval_mode="approve"',
    'mcp_servers.monad.tools.project_ask.approval_mode="approve"',
    'mcp_servers.monad.tools.project_read.approval_mode="approve"',
    'mcp_servers.monad.tools.project_inbox_check.approval_mode="approve"',
    'mcp_servers.monad.tools.project_inbox_ack.approval_mode="approve"',
    'mcp_servers.monad.tools.agent_send.approval_mode="approve"',
    'mcp_servers.monad.tools.agent_read.approval_mode="approve"',
    'mcp_servers.monad.tools.session_members.approval_mode="approve"',
    'mcp_servers.monad.tools.runtime_info.approval_mode="approve"'
  ]);
});
