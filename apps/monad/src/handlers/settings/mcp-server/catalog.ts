import type { McpCatalogEntry } from '@monad/protocol';

// Curated directory of popular MCP servers for one-click "add from catalog". Static reference data —
// an entry only pre-fills the add form; nothing connects until the user reviews and saves (so an
// `env` secret ref like ${env:GITHUB_TOKEN} must be set by the user first). Keep this conservative
// and well-known; third-party/niche servers belong in the file/pack atom install flow.
export const MCP_CATALOG: McpCatalogEntry[] = [
  {
    id: 'filesystem',
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
    name: 'Sequential Thinking',
    description: 'A structured step-by-step reasoning scaffold tool.',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    env: []
  }
];
