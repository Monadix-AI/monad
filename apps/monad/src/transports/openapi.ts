const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);

type OpenApiOperation = {
  summary?: string;
  description?: string;
  tags?: string[];
};

type OpenApiDocument = {
  paths?: Record<string, Record<string, OpenApiOperation>>;
};

const DOMAIN_TAGS: Record<string, string> = {
  a2a: 'A2A',
  agents: 'Agents',
  approvals: 'Approvals',
  atoms: 'Atom Packs',
  channels: 'Channels',
  commands: 'Commands',
  credentials: 'Credentials',
  graph: 'Knowledge graph',
  inbox: 'Inbox',
  init: 'Initialization',
  interactions: 'Interactions',
  laws: 'Memory laws',
  licenses: 'Licenses',
  mcp: 'MCP',
  memory: 'Memory',
  mesh: 'MeshAgents',
  models: 'Models',
  openai: 'OpenAI compatibility',
  sessions: 'Sessions',
  settings: 'Settings',
  skills: 'Skills',
  stats: 'Statistics',
  system: 'System',
  tools: 'Tools',
  usage: 'Usage'
};

function words(value: string): string {
  return value
    .replaceAll(/[:{}]/g, '')
    .replaceAll(/[-_]+/g, ' ')
    .replaceAll(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
}

function routeParts(path: string): string[] {
  return path
    .split('/')
    .filter((part) => part && part !== 'v1')
    .map(words)
    .filter(Boolean);
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function tagForPath(path: string): string {
  const parts = routeParts(path);
  if (parts[0] === 'internal' && parts[1] === 'native agent') return 'Native agent internals';
  if (parts[0] === 'settings' && parts[1]) return `${DOMAIN_TAGS[parts[1]] ?? titleCase(parts[1])} settings`;
  return DOMAIN_TAGS[parts[0] ?? ''] ?? titleCase(parts[0] ?? 'Daemon');
}

function summaryForOperation(method: string, path: string): string {
  const parts = routeParts(path);
  const subject = parts.filter((part) => !/^(id|hash|name|session id|project id)$/.test(part)).join(' ');
  const verb =
    method === 'get'
      ? 'Get'
      : method === 'post'
        ? 'Run'
        : method === 'put'
          ? 'Replace'
          : method === 'patch'
            ? 'Update'
            : method === 'delete'
              ? 'Delete'
              : method === 'head'
                ? 'Inspect'
                : 'Check';
  return `${verb} ${subject || 'daemon resource'}`;
}

export function enrichOpenApiOperations(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const document = value as OpenApiDocument;

  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method) || !operation || typeof operation !== 'object') continue;
      const summary = operation.summary?.trim() || summaryForOperation(method, path);
      operation.summary = summary;
      operation.description =
        operation.description?.trim() || `${summary}. This operation is exposed by the local Monad daemon.`;
      if (!Array.isArray(operation.tags) || operation.tags.length === 0) operation.tags = [tagForPath(path)];
    }
  }

  return document;
}
