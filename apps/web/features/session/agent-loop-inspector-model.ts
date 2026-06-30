import type { UIItem } from '@monad/protocol';
import type { Edge, Node } from '@xyflow/react';

export type InspectorStatus = 'pending' | 'active' | 'done' | 'blocked' | 'error';
export type InspectorTone =
  | 'turn'
  | 'context'
  | 'model'
  | 'thinking'
  | 'output'
  | 'tool'
  | 'skill'
  | 'mcp'
  | 'subagent'
  | 'approval'
  | 'compact'
  | 'clarification'
  | 'system'
  | 'custom';

export interface InspectorNodeData extends Record<string, unknown> {
  detail?: string;
  eventKind?: string;
  item?: UIItem;
  meta?: string;
  seq?: string;
  status: InspectorStatus;
  title: string;
  tone: InspectorTone;
}

export type InspectorNode = Node<InspectorNodeData, 'inspector'>;
type InspectorEdge = Edge<Record<string, unknown>>;

export interface InspectorTimelineEntry {
  detail?: string;
  id: string;
  seq?: string;
  status: InspectorStatus;
  title: string;
  tone: InspectorTone;
}

export interface InspectorFlow {
  currentNodeId: string | null;
  edges: InspectorEdge[];
  nodes: InspectorNode[];
  summary: Record<InspectorStatus, number>;
  timeline: InspectorTimelineEntry[];
}

function textFromMessage(item: Extract<UIItem, { kind: 'message' }>): string {
  return item.parts
    .map((part) => ('text' in part && typeof part.text === 'string' ? part.text : ''))
    .join('')
    .trim();
}

function hasReasoning(item: UIItem): boolean {
  return item.kind === 'message' && item.parts.some((part) => part.type === 'reasoning' && part.text.length > 0);
}

export function classifyTool(tool: string): InspectorTone {
  if (tool === 'skill') return 'skill';
  if (tool === 'agent_delegate' || tool === 'agent_delegate_to' || tool === 'agent_acp_delegate') return 'subagent';
  if (tool.startsWith('mcp_') || tool.includes('__mcp') || tool.includes('mcp__')) return 'mcp';
  return 'tool';
}

function summarizeInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return typeof input === 'string' ? input : undefined;
  const obj = input as Record<string, unknown>;
  for (const key of ['name', 'agent', 'command', 'path', 'query', 'url', 'text', 'prompt', 'question', 'title']) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.length > 56 ? `${value.slice(0, 53)}...` : value;
  }
  return undefined;
}

function node(id: string, position: { x: number; y: number }, data: InspectorNodeData): InspectorNode {
  return { id, type: 'inspector', position, data };
}

function edge(source: string, target: string, active: boolean, id = `${source}->${target}`): InspectorEdge {
  return {
    id,
    source,
    target,
    animated: active,
    markerEnd: { type: 'arrowclosed' },
    style: {
      stroke: active ? 'var(--primary)' : 'color-mix(in oklch, var(--muted-foreground) 42%, transparent)',
      strokeWidth: active ? 2 : 1.25
    }
  };
}

function dedupeItems(items: UIItem[]): UIItem[] {
  const map = new Map<string, UIItem>();
  for (const item of items) map.set(`${item.kind}:${item.id}`, item);
  return [...map.values()].sort((a, b) => a.seq.localeCompare(b.seq));
}

function messageStatus(item: Extract<UIItem, { kind: 'message' }>): InspectorStatus {
  if (item.status === 'error') return 'error';
  if (item.status === 'streaming') return 'active';
  return 'done';
}

function customStatus(item: Extract<UIItem, { kind: 'custom' }>): InspectorStatus {
  if (item.status === 'error') return 'error';
  if (item.status === 'streaming') return 'active';
  return 'done';
}

function timelineEntry(item: InspectorNode): InspectorTimelineEntry {
  return {
    detail: item.data.detail,
    id: item.id,
    seq: item.data.seq,
    status: item.data.status,
    title: item.data.title,
    tone: item.data.tone
  };
}

function chooseCurrentNode(nodes: InspectorNode[]): string | null {
  const latest = (status: InspectorStatus) =>
    nodes
      .filter((item) => item.data.status === status)
      .toSorted((a, b) => (a.data.seq ?? '').localeCompare(b.data.seq ?? ''))
      .at(-1);
  return latest('blocked')?.id ?? latest('active')?.id ?? latest('error')?.id ?? latest('done')?.id ?? null;
}

function summarize(nodes: InspectorNode[]): Record<InspectorStatus, number> {
  return nodes.reduce<Record<InspectorStatus, number>>(
    (acc, item) => {
      acc[item.data.status] += 1;
      return acc;
    },
    { active: 0, blocked: 0, done: 0, error: 0, pending: 0 }
  );
}

export function buildInspectorFlow(items: UIItem[]): InspectorFlow {
  const all = dedupeItems(items);
  const messages = all.filter((item): item is Extract<UIItem, { kind: 'message' }> => item.kind === 'message');
  const tools = all.filter((item): item is Extract<UIItem, { kind: 'tool' }> => item.kind === 'tool');
  const approvals = all.filter((item): item is Extract<UIItem, { kind: 'approval' }> => item.kind === 'approval');
  const clarifications = all.filter(
    (item): item is Extract<UIItem, { kind: 'clarification' }> => item.kind === 'clarification'
  );
  const systems = all.filter((item): item is Extract<UIItem, { kind: 'system' }> => item.kind === 'system');
  const customs = all.filter((item): item is Extract<UIItem, { kind: 'custom' }> => item.kind === 'custom');
  const context = all.find((item): item is Extract<UIItem, { kind: 'context' }> => item.kind === 'context');
  const compact = all.find(
    (item): item is Extract<UIItem, { kind: 'memory_summary' }> => item.kind === 'memory_summary'
  );
  const assistant = messages.filter((item) => item.role === 'assistant');
  const assistantStreaming = assistant.some((item) => item.status === 'streaming');
  const runningTools = tools.filter((item) => item.status === 'running');
  const activeTool = runningTools.at(-1);
  const reasoningSeen = all.some(hasReasoning);
  const reasoningActive = assistant.some((item) => item.status === 'streaming' && hasReasoning(item));
  const outputErrored = assistant.some((item) => item.status === 'error');
  const user = messages.find((item) => item.role === 'user');
  const lastAssistant = assistant.at(-1);

  const baseNodes: InspectorNode[] = [
    node(
      'turn',
      { x: 0, y: 80 },
      {
        detail: user ? textFromMessage(user).slice(0, 88) : 'Waiting for a prompt.',
        eventKind: user?.kind,
        item: user,
        meta: user ? 'accepted' : undefined,
        seq: user?.seq,
        status: user ? messageStatus(user) : 'pending',
        title: 'User turn',
        tone: 'turn'
      }
    ),
    node(
      'context',
      { x: 270, y: 80 },
      {
        detail: context
          ? `${context.usage.used.toLocaleString()} / ${context.usage.contextLimit.toLocaleString()} tokens`
          : 'Prompt, memory, tools, and history are assembled before the model call.',
        eventKind: context?.kind,
        item: context,
        meta: context ? `${context.usage.segments.length} buckets` : undefined,
        seq: context?.seq,
        status: context ? 'done' : user ? 'active' : 'pending',
        title: 'Context',
        tone: 'context'
      }
    ),
    node(
      'model',
      { x: 540, y: 80 },
      {
        detail:
          tools.length > 0
            ? `${tools.length} tool step${tools.length === 1 ? '' : 's'} requested`
            : 'Reasoning loop and model response.',
        meta: assistant.length > 0 ? `${assistant.length} segment${assistant.length === 1 ? '' : 's'}` : undefined,
        seq: assistant.at(-1)?.seq ?? tools.at(-1)?.seq,
        status: outputErrored
          ? 'error'
          : assistantStreaming && runningTools.length === 0
            ? 'active'
            : assistant.length > 0 || tools.length > 0
              ? 'done'
              : user
                ? 'active'
                : 'pending',
        title: 'Model',
        tone: 'model'
      }
    ),
    node(
      'thinking',
      { x: 810, y: -20 },
      {
        detail: reasoningSeen
          ? 'Reasoning deltas are grouped separately from the answer.'
          : 'No reasoning stream observed for this turn.',
        seq: assistant.find(hasReasoning)?.seq,
        status: reasoningActive ? 'active' : reasoningSeen ? 'done' : 'pending',
        title: 'Thinking',
        tone: 'thinking'
      }
    ),
    node(
      'output',
      { x: 1080, y: 80 },
      {
        detail: lastAssistant ? textFromMessage(lastAssistant).slice(0, 88) : 'Final assistant output appears here.',
        eventKind: lastAssistant?.kind,
        item: lastAssistant,
        seq: lastAssistant?.seq,
        status: outputErrored ? 'error' : assistantStreaming ? 'active' : assistant.length > 0 ? 'done' : 'pending',
        title: 'Output',
        tone: 'output'
      }
    )
  ];

  const optionalNodes: InspectorNode[] = [];
  if (compact) {
    optionalNodes.push(
      node(
        'compact',
        { x: 270, y: 260 },
        {
          detail: compact.summary.slice(0, 96),
          eventKind: compact.kind,
          item: compact,
          meta: compact.uptoMessageId,
          seq: compact.seq,
          status: 'done',
          title: 'Compact',
          tone: 'compact'
        }
      )
    );
  }
  approvals.forEach((approval, index) => {
    optionalNodes.push(
      node(
        `approval:${approval.id}`,
        { x: 540 + index * 245, y: 260 },
        {
          detail: summarizeInput(approval.input),
          eventKind: approval.kind,
          item: approval,
          meta: approval.key,
          seq: approval.seq,
          status: 'blocked',
          title: `Approval · ${approval.tool}`,
          tone: 'approval'
        }
      )
    );
  });
  clarifications.forEach((clarification, index) => {
    optionalNodes.push(
      node(
        `clarification:${clarification.id}`,
        { x: 540 + index * 245, y: 260 },
        {
          detail: clarification.question,
          eventKind: clarification.kind,
          item: clarification,
          meta: clarification.options ? `${clarification.options.length} options` : undefined,
          seq: clarification.seq,
          status: 'blocked',
          title: 'Clarification',
          tone: 'clarification'
        }
      )
    );
  });
  tools.forEach((toolItem, index) => {
    const tone = classifyTool(toolItem.tool);
    optionalNodes.push(
      node(
        `tool:${toolItem.id}`,
        { x: 540 + (index % 3) * 245, y: 430 + Math.floor(index / 3) * 165 },
        {
          detail: summarizeInput(toolItem.input) ?? toolItem.output?.slice(0, 72),
          eventKind: toolItem.kind,
          item: toolItem,
          meta: toolItem.status === 'running' ? undefined : toolItem.status,
          seq: toolItem.seq,
          status: toolItem.status === 'running' ? 'active' : toolItem.status === 'error' ? 'error' : 'done',
          title: `${tone === 'subagent' ? 'Subagent' : tone === 'skill' ? 'Skill' : tone === 'mcp' ? 'MCP' : 'Tool'} · ${toolItem.tool}`,
          tone
        }
      )
    );
  });
  systems.forEach((system, index) => {
    optionalNodes.push(
      node(
        `system:${system.id}`,
        { x: (index % 2) * 245, y: 260 + Math.floor(index / 2) * 145 },
        {
          detail: system.text.slice(0, 96),
          eventKind: system.kind,
          item: system,
          meta: system.level,
          seq: system.seq,
          status: system.level === 'error' ? 'error' : 'done',
          title: 'System',
          tone: 'system'
        }
      )
    );
  });
  customs.forEach((custom, index) => {
    optionalNodes.push(
      node(
        `custom:${custom.id}`,
        { x: 1080 + (index % 2) * 245, y: 260 + Math.floor(index / 2) * 145 },
        {
          detail: summarizeInput(custom.data),
          eventKind: custom.kind,
          item: custom,
          meta: custom.name,
          seq: custom.seq,
          status: customStatus(custom),
          title: `Event · ${custom.name}`,
          tone: 'custom'
        }
      )
    );
  });

  const nodes = [...baseNodes, ...optionalNodes];
  const edges: InspectorEdge[] = [
    edge('turn', 'context', user !== undefined),
    edge('context', 'model', user !== undefined),
    edge('model', 'thinking', reasoningActive || reasoningSeen),
    edge('thinking', 'output', assistantStreaming || assistant.length > 0),
    edge('model', 'output', assistantStreaming || (assistant.length > 0 && !reasoningSeen))
  ];
  if (compact) edges.push(edge('context', 'compact', false));
  for (const approval of approvals) edges.push(edge('model', `approval:${approval.id}`, true));
  for (const clarification of clarifications) edges.push(edge('model', `clarification:${clarification.id}`, true));
  for (const system of systems) edges.push(edge('turn', `system:${system.id}`, false));
  for (const custom of customs) edges.push(edge('model', `custom:${custom.id}`, custom.status === 'streaming'));
  for (const toolItem of tools) {
    const id = `tool:${toolItem.id}`;
    const isActive = activeTool?.id === toolItem.id;
    edges.push(edge('model', id, isActive, `model->${id}`));
    edges.push(edge(id, 'model', toolItem.status !== 'running', `${id}->model`));
  }

  const timeline = nodes
    .filter((item) => item.data.seq || item.data.status !== 'pending')
    .map(timelineEntry)
    .sort((a, b) => (a.seq ?? '').localeCompare(b.seq ?? ''));
  return { currentNodeId: chooseCurrentNode(nodes), edges, nodes, summary: summarize(nodes), timeline };
}
