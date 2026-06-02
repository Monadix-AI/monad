import type { CreateAgentCredentialRequest, UpdateAgentCredentialRequest } from '@monad/protocol';

import { agentCredentialEnvironmentVariableSchema, agentCredentialHostSchema } from '@monad/protocol';

export interface CredentialFormState {
  label: string;
  description: string;
  environmentVariable: string;
  allowedHosts: string;
  secret: string;
  secretAction: 'keep' | 'replace' | 'remove';
}

export function parseAllowedHosts(value: string): string[] {
  const hosts = value
    .split(/[,\n]/)
    .map((host) => host.trim())
    .filter(Boolean)
    .map((host) => agentCredentialHostSchema.parse(host));
  return Array.from(new Set(hosts));
}

export function validateCredentialForm(state: CredentialFormState, editing: boolean): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!state.label.trim()) errors.label = 'required';
  if (!agentCredentialEnvironmentVariableSchema.safeParse(state.environmentVariable.trim()).success) {
    errors.environmentVariable = 'invalid';
  }
  try {
    if (parseAllowedHosts(state.allowedHosts).length === 0) errors.allowedHosts = 'required';
  } catch {
    errors.allowedHosts = 'invalid';
  }
  if ((!editing || state.secretAction === 'replace') && !state.secret) errors.secret = 'required';
  return errors;
}

export function createCredentialRequest(state: CredentialFormState): CreateAgentCredentialRequest {
  return {
    label: state.label.trim(),
    ...(state.description.trim() ? { description: state.description.trim() } : {}),
    environmentVariable: state.environmentVariable.trim(),
    allowedHosts: parseAllowedHosts(state.allowedHosts),
    secret: state.secret
  };
}

export function updateCredentialRequest(state: CredentialFormState): UpdateAgentCredentialRequest {
  return {
    label: state.label.trim(),
    description: state.description.trim() || undefined,
    environmentVariable: state.environmentVariable.trim(),
    allowedHosts: parseAllowedHosts(state.allowedHosts),
    ...(state.secretAction === 'replace'
      ? { secret: { action: 'replace' as const, value: state.secret } }
      : state.secretAction === 'remove'
        ? { secret: { action: 'remove' as const } }
        : {})
  };
}
