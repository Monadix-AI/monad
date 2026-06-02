export type ApiTokenAction = 'generate' | 'rotate';

export function getApiTokenAction(token: string | undefined): ApiTokenAction {
  return token ? 'rotate' : 'generate';
}

export function createApiToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `sk-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
