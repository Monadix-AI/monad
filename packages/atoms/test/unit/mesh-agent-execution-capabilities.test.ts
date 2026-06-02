import { expect, test } from 'bun:test';

import { antigravityMeshAgentAdapter } from '../../src/agent-adapters/antigravity/index.ts';
import { claudeCodeMeshAgentAdapter } from '../../src/agent-adapters/claude-code/index.ts';
import { codexMeshAgentAdapter } from '../../src/agent-adapters/codex/index.ts';
import { geminiMeshAgentAdapter } from '../../src/agent-adapters/gemini/index.ts';
import { hermesMeshAgentAdapter } from '../../src/agent-adapters/hermes/index.ts';
import { monadMeshAgentAdapter } from '../../src/agent-adapters/monad/index.ts';
import { openClawMeshAgentAdapter } from '../../src/agent-adapters/openclaw/index.ts';
import { qwenMeshAgentAdapter } from '../../src/agent-adapters/qwen/index.ts';

test('built-in adapters declare the execution modes their managed runtime implements', () => {
  expect(
    [
      codexMeshAgentAdapter,
      claudeCodeMeshAgentAdapter,
      geminiMeshAgentAdapter,
      qwenMeshAgentAdapter,
      antigravityMeshAgentAdapter,
      hermesMeshAgentAdapter,
      openClawMeshAgentAdapter,
      monadMeshAgentAdapter
    ].map((adapter) => [adapter.provider, adapter.executionCapabilities])
  ).toEqual([
    ['codex', { autopilot: true, fastMode: true }],
    ['claude-code', { autopilot: true, fastMode: true }],
    ['gemini', { autopilot: true, fastMode: false }],
    ['qwen', { autopilot: true, fastMode: false }],
    ['antigravity', { autopilot: true, fastMode: false }],
    ['hermes', { autopilot: true, fastMode: false }],
    ['openclaw', { autopilot: false, fastMode: false }],
    ['monad', { autopilot: true, fastMode: false }]
  ]);
});
