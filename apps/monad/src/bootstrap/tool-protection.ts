import type { Tool } from '@/capabilities/tools/types.ts';

import { normalize, resolve, sep } from 'node:path';

export function withSandboxConstraints(tool: Tool, roots: string[] | undefined): Tool {
  if (!roots) return tool;
  if (!tool.scopes?.some((s) => s.resource.startsWith('fs:'))) return tool;
  return {
    ...tool,
    scopes: tool.scopes.map((s) =>
      s.resource.startsWith('fs:') ? { ...s, constraints: { ...s.constraints, roots } } : s
    )
  };
}

function hasCredentialsPath(value: unknown, credentialsDir: string): boolean {
  if (typeof value === 'string') {
    const abs = resolve(value);
    const credNorm = normalize(credentialsDir);
    return abs === credNorm || abs.startsWith(credNorm + sep) || value.includes(credentialsDir);
  }
  if (Array.isArray(value)) return value.some((v) => hasCredentialsPath(v, credentialsDir));
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((v) => hasCredentialsPath(v, credentialsDir));
  }
  return false;
}

export function withCredentialsProtection(tool: Tool, credentialsDir: string): Tool {
  const existing = tool.needsApproval as ((input: unknown, ctx: unknown) => boolean | Promise<boolean>) | undefined;
  const baseHighRisk = tool.highRisk === true;
  return {
    ...tool,
    needsApproval: async (input: unknown, ctx: unknown) => {
      if (hasCredentialsPath(input, credentialsDir)) return true;
      if (existing) return existing(input, ctx);
      return baseHighRisk;
    }
  };
}
