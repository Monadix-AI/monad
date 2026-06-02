import type { AgentCredentialView } from '@monad/protocol';

export function toggleCredentialGrant(credentialIds: string[], credentialId: string): string[] {
  return credentialIds.includes(credentialId)
    ? credentialIds.filter((current) => current !== credentialId)
    : [...credentialIds, credentialId];
}

export function duplicateGrantedEnvironmentVariables(
  credentials: AgentCredentialView[],
  credentialIds: string[]
): string[] {
  const selectedIds = new Set(credentialIds);
  const counts = new Map<string, number>();
  for (const credential of credentials) {
    if (!selectedIds.has(credential.id)) continue;
    counts.set(credential.environmentVariable, (counts.get(credential.environmentVariable) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([environmentVariable]) => environmentVariable)
    .sort();
}
