import type { ToolContext } from '#/capabilities/tools/types.ts';

import { expect, test } from 'bun:test';

import { normalizePathApprovalKey } from '#/capabilities/tools/approval/path-gate.ts';
import { createApprovalPolicy } from '#/capabilities/tools/approval/policy.ts';
import {
  approvalDeniedMessage,
  buildResourceApprovalRequest,
  createApprovalGate,
  RESOURCE_APPROVAL_TOOLS,
  requestNetworkAccess,
  requestPathAccess
} from '#/capabilities/tools/approval/resource-approval.ts';

test('RESOURCE_APPROVAL_TOOLS centralizes remembered approval tool names', () => {
  expect(RESOURCE_APPROVAL_TOOLS.pathAccess).toBe('path_access');
  expect(RESOURCE_APPROVAL_TOOLS.networkAccess).toBe('network_access');
});

test('requestPathAccess emits a normalized path_access approval request', async () => {
  const calls: Array<{ tool: string; key?: string; highRisk: boolean; input: unknown }> = [];
  const ctx: ToolContext = {
    sessionId: 'ses_100000000000',
    sandboxRoots: ['/work'],
    log: () => {},
    gate: async (req) => {
      calls.push({ tool: req.tool, key: req.key, highRisk: req.highRisk, input: req.input });
      return { allow: true };
    }
  };

  const outcome = await requestPathAccess(ctx, {
    path: '/outside/file.txt',
    dir: '/outside',
    operation: 'write',
    pathKind: 'directory',
    requestedByTool: 'file_write',
    reason: 'path escapes sandbox'
  });

  expect(outcome).toEqual({ allow: true });
  expect(calls).toEqual([
    {
      tool: 'path_access',
      key: 'write:/outside',
      highRisk: false,
      input: {
        path: '/outside/file.txt',
        dir: '/outside',
        operation: 'write',
        pathKind: 'directory',
        requestedByTool: 'file_write',
        defaultScope: 'session',
        rememberScopes: ['once', 'session', 'agent', 'global'],
        reason: 'path escapes sandbox',
        displayHint: {
          kind: 'resource-approval',
          resource: 'path',
          subject: '/outside',
          operation: 'write',
          defaultScope: 'session',
          rememberScopes: ['once', 'session', 'agent', 'global']
        }
      }
    }
  ]);
});

test('path approval keys separate write/cwd/execute while read remains directory scoped', () => {
  expect(
    buildResourceApprovalRequest({
      resource: 'path',
      request: { path: '/outside/file.txt', dir: '/outside', operation: 'read' }
    }).key
  ).toBe('/outside');
  expect(
    buildResourceApprovalRequest({
      resource: 'path',
      request: { path: '/outside/file.txt', dir: '/outside', operation: 'write' }
    }).key
  ).toBe('write:/outside');
  expect(
    buildResourceApprovalRequest({
      resource: 'path',
      request: { path: '/outside', dir: '/outside', operation: 'cwd' }
    }).key
  ).toBe('cwd:/outside');
});

test('createApprovalGate exposes the normalized resource approval methods', async () => {
  const calls: Array<{ tool: string; key?: string }> = [];
  const gate = createApprovalGate({
    sessionId: 'ses_100000000000',
    sandboxRoots: ['/work'],
    log: () => {},
    gate: async (req) => {
      calls.push({ tool: req.tool, key: req.key });
      return { allow: true };
    }
  });

  await gate.requestPathAccess({ path: '/tmp/a.txt', dir: '/tmp' });

  expect(calls).toEqual([{ tool: 'path_access', key: '/tmp' }]);
});

test('requestNetworkAccess emits a normalized network_access approval request keyed by host', async () => {
  const calls: Array<{ tool: string; key?: string; highRisk: boolean; input: unknown }> = [];
  const ctx: ToolContext = {
    sessionId: 'ses_100000000000',
    log: () => {},
    gate: async (req) => {
      calls.push({ tool: req.tool, key: req.key, highRisk: req.highRisk, input: req.input });
      return { allow: true };
    }
  };

  const outcome = await requestNetworkAccess(ctx, {
    url: 'https://example.com/docs?q=1',
    host: 'Example.COM.',
    protocol: 'https',
    reason: 'net_fetch'
  });

  expect(outcome).toEqual({ allow: true });
  expect(calls).toEqual([
    {
      tool: 'network_access',
      key: 'example.com',
      highRisk: false,
      input: {
        url: 'https://example.com/docs?q=1',
        host: 'example.com',
        protocol: 'https',
        defaultScope: 'session',
        rememberScopes: ['once', 'session', 'agent', 'global'],
        reason: 'net_fetch',
        displayHint: {
          kind: 'resource-approval',
          resource: 'network',
          subject: 'example.com',
          defaultScope: 'session',
          rememberScopes: ['once', 'session', 'agent', 'global']
        }
      }
    }
  ]);
});

test('buildResourceApprovalRequest is the single payload root for resource approvals', () => {
  expect(
    buildResourceApprovalRequest({
      resource: 'network',
      request: { url: 'https://Example.COM/', host: 'Example.COM.', protocol: 'https' }
    })
  ).toEqual({
    tool: 'network_access',
    key: 'example.com',
    highRisk: false,
    input: {
      url: 'https://Example.COM/',
      host: 'example.com',
      protocol: 'https',
      defaultScope: 'session',
      rememberScopes: ['once', 'session', 'agent', 'global'],
      displayHint: {
        kind: 'resource-approval',
        resource: 'network',
        subject: 'example.com',
        defaultScope: 'session',
        rememberScopes: ['once', 'session', 'agent', 'global']
      }
    }
  });
});

test('createApprovalPolicy centralizes resource gate decisions', () => {
  const policy = createApprovalPolicy();
  expect(policy.shouldRequestNetworkApproval({ sessionId: 'ses_100000000000', log: () => {} })).toBe(false);
  expect(
    policy.shouldRequestNetworkApproval({ sessionId: 'ses_100000000000', sandboxRoots: ['/sandbox'], log: () => {} })
  ).toBe(true);
  expect(policy.resourceScopes('path')).toEqual({
    defaultScope: 'session',
    rememberScopes: ['once', 'session', 'agent', 'global']
  });
});

test('approvalDeniedMessage standardizes resource denial text', () => {
  expect(approvalDeniedMessage('network', 'example.com')).toBe('network access denied: example.com');
  expect(approvalDeniedMessage('path')).toBe('path access denied');
});

test('normalizePathApprovalKey canonicalizes Windows drive and UNC keys case-insensitively', () => {
  expect(normalizePathApprovalKey('C:\\Users\\Zeke\\Project\\..\\Project')).toBe('c:\\users\\zeke\\project');
  expect(normalizePathApprovalKey('\\\\SERVER\\Share\\Dir\\..')).toBe('\\\\server\\share\\');
});
