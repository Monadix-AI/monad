import { z } from 'zod';

import { approvalScopeSchema } from './approvals.ts';

export const resourceApprovalOperationSchema = z.enum(['read', 'write', 'execute', 'cwd']);
export type ResourceApprovalOperation = z.infer<typeof resourceApprovalOperationSchema>;

export const resourceApprovalDisplaySchema = z.object({
  kind: z.literal('resource-approval'),
  resource: z.enum(['path', 'network']),
  subject: z.string().optional(),
  operation: resourceApprovalOperationSchema.optional(),
  defaultScope: approvalScopeSchema.optional(),
  rememberScopes: z.array(approvalScopeSchema).optional()
});
export type ResourceApprovalDisplay = z.infer<typeof resourceApprovalDisplaySchema>;

const resourceApprovalScopeMetadataSchema = z.object({
  defaultScope: approvalScopeSchema,
  rememberScopes: z.array(approvalScopeSchema)
});
export type ResourceApprovalScopeMetadata = z.infer<typeof resourceApprovalScopeMetadataSchema>;

export const pathResourceApprovalPayloadSchema = resourceApprovalScopeMetadataSchema.extend({
  path: z.string(),
  dir: z.string(),
  operation: resourceApprovalOperationSchema.optional(),
  pathKind: z.enum(['file', 'directory', 'unknown']).optional(),
  requestedByTool: z.string().optional(),
  reason: z.string().optional(),
  displayHint: resourceApprovalDisplaySchema.optional()
});
export type PathResourceApprovalPayload = z.infer<typeof pathResourceApprovalPayloadSchema>;

export const networkResourceApprovalPayloadSchema = resourceApprovalScopeMetadataSchema.extend({
  url: z.string(),
  host: z.string(),
  protocol: z.enum(['http', 'https']),
  reason: z.string().optional(),
  displayHint: resourceApprovalDisplaySchema.optional()
});
export type NetworkResourceApprovalPayload = z.infer<typeof networkResourceApprovalPayloadSchema>;

export const resourceApprovalPayloadSchema = z.union([
  pathResourceApprovalPayloadSchema,
  networkResourceApprovalPayloadSchema
]);
export type ResourceApprovalPayload = z.infer<typeof resourceApprovalPayloadSchema>;
