import type { ApprovalScope } from '@monad/protocol';
import type { ToolContext } from '../types.ts';

import { sandboxNetMode } from '@monad/sandbox';

type ResourceApprovalKind = 'network' | 'path';

interface ResourceScopePolicy {
  defaultScope: ApprovalScope;
  rememberScopes: ApprovalScope[];
}

export interface ApprovalPolicy {
  shouldRequestNetworkApproval(ctx: ToolContext): boolean;
  resourceScopes(resource: ResourceApprovalKind): ResourceScopePolicy;
}

const RESOURCE_SCOPES: ResourceScopePolicy = {
  defaultScope: 'session',
  rememberScopes: ['once', 'session', 'agent', 'global']
};

export function createApprovalPolicy(): ApprovalPolicy {
  return {
    resourceScopes: () => RESOURCE_SCOPES,
    shouldRequestNetworkApproval: (ctx) => Boolean(ctx.sandboxRoots?.length) || sandboxNetMode() !== 'unrestricted'
  };
}

export const defaultApprovalPolicy = createApprovalPolicy();
