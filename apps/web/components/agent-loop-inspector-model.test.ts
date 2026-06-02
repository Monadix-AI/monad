import type { UIItem } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { buildInspectorFlow, classifyTool } from './agent-loop-inspector-model';

test('classifies runtime tool families', () => {
  expect(classifyTool('skill')).toBe('skill');
  expect(classifyTool('agent_delegate_to')).toBe('subagent');
  expect(classifyTool('mcp_filesystem_read')).toBe('mcp');
  expect(classifyTool('server__mcp_call')).toBe('mcp');
  expect(classifyTool('fs_read')).toBe('tool');
});

test('builds an inspectable flow with timeline and raw items', () => {
  const items: UIItem[] = [
    {
      id: 'msg_user',
      kind: 'message',
      parts: [{ text: 'Check the repo', type: 'text' }],
      role: 'user',
      seq: '0001',
      status: 'done'
    },
    {
      id: 'context',
      kind: 'context',
      seq: '0002',
      usage: {
        approximate: false,
        autocompactBuffer: 1000,
        contextLimit: 10_000,
        free: 8000,
        segments: [{ category: 'messages', label: 'Messages', tokens: 1200 }],
        used: 2000
      }
    },
    {
      id: 'call_1',
      input: { path: 'AGENTS.md' },
      kind: 'tool',
      output: 'ok',
      seq: '0003',
      status: 'ok',
      tool: 'fs_read'
    },
    {
      id: 'msg_assistant',
      kind: 'message',
      parts: [
        { text: 'thinking', type: 'reasoning' },
        { text: 'Done', type: 'text' }
      ],
      role: 'assistant',
      seq: '0004',
      status: 'done'
    }
  ];

  const flow = buildInspectorFlow(items);
  const tool = flow.nodes.find((node) => node.id === 'tool:call_1');
  const thinking = flow.nodes.find((node) => node.id === 'thinking');

  expect(flow.currentNodeId).toBe('output');
  expect(flow.summary.done).toBeGreaterThanOrEqual(4);
  expect(tool?.data).toMatchObject({
    detail: 'AGENTS.md',
    item: items[2],
    status: 'done',
    title: 'Tool · fs_read',
    tone: 'tool'
  });
  expect(thinking?.data.status).toBe('done');
  expect(flow.timeline.map((entry) => entry.id)).toContain('tool:call_1');
  expect(flow.edges.some((edge) => edge.id === 'tool:call_1->model')).toBe(true);
});

test('projects approvals, clarifications, custom events, and system notices', () => {
  const items: UIItem[] = [
    {
      id: 'msg_user',
      kind: 'message',
      parts: [{ text: 'Run it', type: 'text' }],
      role: 'user',
      seq: '0001'
    },
    {
      id: 'req_1',
      input: { command: 'bun test' },
      key: 'host-control',
      kind: 'approval',
      seq: '0002',
      tool: 'shell_exec'
    },
    {
      id: 'clarify_1',
      kind: 'clarification',
      options: ['A', 'B'],
      question: 'Which target?',
      seq: '0003'
    },
    {
      data: { taskId: 'tsk_1', title: 'Inspect plan' },
      id: 'tsk_1',
      kind: 'custom',
      name: 'task.created',
      seq: '0004',
      status: 'streaming'
    },
    {
      id: 'sys_1',
      kind: 'system',
      level: 'warn',
      seq: '0005',
      text: 'Recovered stream'
    }
  ];

  const flow = buildInspectorFlow(items);

  expect(flow.currentNodeId).toBe('clarification:clarify_1');
  expect(flow.summary.blocked).toBe(2);
  expect(flow.summary.active).toBe(3);
  expect(flow.nodes.find((node) => node.id === 'approval:req_1')?.data.status).toBe('blocked');
  expect(flow.nodes.find((node) => node.id === 'clarification:clarify_1')?.data).toMatchObject({
    meta: '2 options',
    status: 'blocked',
    tone: 'clarification'
  });
  expect(flow.nodes.find((node) => node.id === 'custom:tsk_1')?.data).toMatchObject({
    detail: 'Inspect plan',
    status: 'active',
    tone: 'custom'
  });
  expect(flow.nodes.find((node) => node.id === 'system:sys_1')?.data).toMatchObject({
    meta: 'warn',
    tone: 'system'
  });
});
