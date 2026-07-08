import { resolveSecretRef } from '#/config/secrets.ts';

export function resolveToken(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  try {
    return resolveSecretRef(ref);
  } catch {
    return undefined;
  }
}
