import type {
  NetworkResourceApprovalPayload,
  PathResourceApprovalPayload,
  ResourceApprovalDisplay,
  ResourceApprovalOperation
} from '@monad/protocol';
import type { ToolContext, ToolGateOutcome } from '../types.ts';

import { normalizeHost } from '@monad/sandbox';

import { defaultApprovalPolicy } from './policy.ts';

export const RESOURCE_APPROVAL_TOOLS = {
  pathAccess: 'path_access',
  networkAccess: 'network_access'
} as const;

export interface PathAccessApproval {
  path: string;
  dir: string;
  operation?: ResourceApprovalOperation;
  pathKind?: 'file' | 'directory' | 'unknown';
  requestedByTool?: string;
  reason?: string;
  displayHint?: ResourceApprovalDisplay;
}

export interface NetworkAccessApproval {
  url: string;
  host: string;
  protocol: 'http' | 'https';
  reason?: string;
  displayHint?: ResourceApprovalDisplay;
}

export interface ApprovalGate {
  requestPathAccess(request: PathAccessApproval): Promise<ToolGateOutcome>;
  requestNetworkAccess(request: NetworkAccessApproval): Promise<ToolGateOutcome>;
}

type ResourceApprovalInput =
  | { resource: 'path'; request: PathAccessApproval }
  | { resource: 'network'; request: NetworkAccessApproval };

function pathApprovalKey(dir: string, operation?: ResourceApprovalOperation): string {
  return operation && operation !== 'read' ? `${operation}:${dir}` : dir;
}

export function buildResourceApprovalRequest(input: ResourceApprovalInput): {
  tool: string;
  key: string;
  highRisk: false;
  input: PathResourceApprovalPayload | NetworkResourceApprovalPayload;
} {
  if (input.resource === 'path') {
    const scopes = defaultApprovalPolicy.resourceScopes('path');
    const request = {
      ...input.request,
      ...scopes,
      displayHint: {
        kind: 'resource-approval',
        resource: 'path',
        subject: input.request.dir,
        ...(input.request.operation ? { operation: input.request.operation } : {}),
        ...scopes
      } satisfies ResourceApprovalDisplay
    };
    return {
      tool: RESOURCE_APPROVAL_TOOLS.pathAccess,
      key: pathApprovalKey(request.dir, request.operation),
      highRisk: false,
      input: request
    };
  }
  const scopes = defaultApprovalPolicy.resourceScopes('network');
  const request = {
    ...input.request,
    host: normalizeHost(input.request.host),
    ...scopes,
    displayHint: {
      kind: 'resource-approval',
      resource: 'network',
      subject: normalizeHost(input.request.host),
      ...scopes
    } satisfies ResourceApprovalDisplay
  };
  return {
    tool: RESOURCE_APPROVAL_TOOLS.networkAccess,
    key: request.host,
    highRisk: false,
    input: request
  };
}

export function approvalDeniedMessage(resource: 'path' | 'network', subject?: string): string {
  return subject ? `${resource} access denied: ${subject}` : `${resource} access denied`;
}

/**
 * Typed facade over ToolGate for resource-scoped approvals. Keep resource naming, keys,
 * and audit payloads centralized so file/shell/process/network tools do not drift.
 */
export async function requestPathAccess(ctx: ToolContext, request: PathAccessApproval): Promise<ToolGateOutcome> {
  if (!ctx.gate) return { allow: false, reason: 'approval gate unavailable' };
  const built = buildResourceApprovalRequest({ resource: 'path', request });
  return ctx.gate({
    tool: built.tool,
    key: built.key,
    sessionId: ctx.sessionId,
    highRisk: built.highRisk,
    input: built.input
  });
}

export async function requestNetworkAccess(ctx: ToolContext, request: NetworkAccessApproval): Promise<ToolGateOutcome> {
  if (!ctx.gate) return { allow: false, reason: 'approval gate unavailable' };
  const built = buildResourceApprovalRequest({ resource: 'network', request });
  return ctx.gate({
    tool: built.tool,
    key: built.key,
    sessionId: ctx.sessionId,
    highRisk: built.highRisk,
    input: built.input
  });
}

export function createApprovalGate(ctx: ToolContext): ApprovalGate {
  return {
    requestNetworkAccess: (request) => requestNetworkAccess(ctx, request),
    requestPathAccess: (request) => requestPathAccess(ctx, request)
  };
}
