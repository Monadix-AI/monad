export interface McpTaskProgress {
  type: 'mcp_task';
  server: string;
  tool: string;
  taskId: string;
  status: 'working' | 'input_required';
  statusMessage?: string;
  lastUpdatedAt: string;
}

export function parseMcpTaskProgress(raw: string | undefined): McpTaskProgress | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const value = parsed as Partial<McpTaskProgress>;
  if (
    value.type !== 'mcp_task' ||
    typeof value.server !== 'string' ||
    typeof value.tool !== 'string' ||
    typeof value.taskId !== 'string' ||
    (value.status !== 'working' && value.status !== 'input_required') ||
    typeof value.lastUpdatedAt !== 'string'
  ) {
    return null;
  }
  return {
    type: 'mcp_task',
    server: value.server,
    tool: value.tool,
    taskId: value.taskId,
    status: value.status,
    ...(typeof value.statusMessage === 'string' ? { statusMessage: value.statusMessage } : {}),
    lastUpdatedAt: value.lastUpdatedAt
  };
}
