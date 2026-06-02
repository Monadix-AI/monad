import type { McpRegistryAdapter, McpRegistryEntry } from '../adapter.ts';

const BUILT_IN_ENTRIES: McpRegistryEntry[] = [
  {
    id: 'filesystem',
    registry: 'built-in',
    name: 'Filesystem',
    description: 'Read/write files under an allowed directory.',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
    env: []
  },
  {
    id: 'git',
    registry: 'built-in',
    name: 'Git',
    description: 'Read, search, and inspect a local Git repository.',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-git'],
    env: []
  },
  {
    id: 'github',
    registry: 'built-in',
    name: 'GitHub',
    description: 'Manage issues, PRs, and repositories via the GitHub API.',
    homepage: 'https://github.com/github/github-mcp-server',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: ['GITHUB_PERSONAL_ACCESS_TOKEN']
  },
  {
    id: 'postgres',
    registry: 'built-in',
    name: 'PostgreSQL',
    description: 'Query a PostgreSQL database (read-only).',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/postgres',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres', 'postgres://localhost/postgres'],
    env: []
  },
  {
    id: 'sqlite',
    registry: 'built-in',
    name: 'SQLite',
    description: 'Query and explore a local SQLite database.',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sqlite', '--db-path', './data.db'],
    env: []
  },
  {
    id: 'fetch',
    registry: 'built-in',
    name: 'Fetch',
    description: 'Fetch a URL and convert the page to Markdown for the model.',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-fetch'],
    env: []
  },
  {
    id: 'memory',
    registry: 'built-in',
    name: 'Memory',
    description: 'A persistent knowledge-graph memory the agent can read and write.',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    env: []
  },
  {
    id: 'brave-search',
    registry: 'built-in',
    name: 'Brave Search',
    description: 'Web and local search via the Brave Search API.',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    env: ['BRAVE_API_KEY']
  },
  {
    id: 'slack',
    registry: 'built-in',
    name: 'Slack',
    description: 'Read and post Slack messages and manage channels.',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/slack',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    env: ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID']
  },
  {
    id: 'sequential-thinking',
    registry: 'built-in',
    name: 'Sequential Thinking',
    description: 'A structured step-by-step reasoning scaffold tool.',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    env: []
  }
];

export class BuiltInMcpAdapter implements McpRegistryAdapter {
  readonly id = 'built-in';

  async search(query: string, opts?: { limit?: number }): Promise<McpRegistryEntry[]> {
    const q = query.toLowerCase();
    const limit = opts?.limit ?? 20;
    if (!q) return BUILT_IN_ENTRIES.slice(0, limit);
    return BUILT_IN_ENTRIES.filter(
      (e) => e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q)
    ).slice(0, limit);
  }
}
