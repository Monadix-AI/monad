import type { ApprovalRule } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { approvalRuleLabel } from '../../features/studio/approvals-settings';

function rule(overrides: Partial<ApprovalRule>): ApprovalRule {
  return {
    id: 'apr_1',
    tool: 'path_access',
    key: '/tmp/project',
    decision: 'allow',
    scope: 'global',
    createdAt: '2026-07-08T00:00:00.000Z',
    source: 'runtime',
    ...overrides
  };
}

const t = (key: string) => (key === 'web.chat.pathAccessTitle' ? 'File access' : key);

test('approvalRuleLabel renders operation-scoped path access keys clearly', () => {
  expect(approvalRuleLabel(rule({ key: 'write:/tmp/project' }), t)).toBe('File access · write · /tmp/project');
  expect(approvalRuleLabel(rule({ key: 'cwd:/tmp/project' }), t)).toBe('File access · cwd · /tmp/project');
});

test('approvalRuleLabel keeps read-style path access keys as filesystem access', () => {
  expect(approvalRuleLabel(rule({ key: '/tmp/project' }), t)).toBe('File access · /tmp/project');
});

test('approvalRuleLabel preserves non-path keyed tools', () => {
  expect(approvalRuleLabel(rule({ tool: 'shell_exec', key: 'git' }), t)).toBe('shell_exec(git)');
});
