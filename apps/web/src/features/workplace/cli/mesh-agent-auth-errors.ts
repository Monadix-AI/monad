function errorCode(error: unknown): string | undefined {
  const candidate = error as { code?: unknown; raw?: { code?: unknown } } | null;
  const code = candidate?.code ?? candidate?.raw?.code;
  return typeof code === 'string' ? code : undefined;
}

export function meshAgentAuthErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const candidate = error as { message?: unknown } | null;
  return typeof candidate?.message === 'string' ? candidate.message : JSON.stringify(error);
}

/** The agent itself is gone from settings (disconnected while the login modal was open): restarting
 *  the login session would only 404 again, so the modal must stop retrying instead of looping. */
export function meshAgentGone(error: unknown): boolean {
  return errorCode(error) === 'MESH_AGENT_NOT_FOUND';
}

export function meshAgentAuthSessionMissing(error: unknown): boolean {
  if (meshAgentGone(error)) return false;
  const text = meshAgentAuthErrorMessage(error);
  return text.includes('404') || text.includes('not found');
}
