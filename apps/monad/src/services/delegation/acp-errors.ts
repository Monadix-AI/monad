import type { AcpAgentConfig } from '@monad/environment';
import type { LocalePack, Translate } from '@monad/i18n';

import { createI18n } from '@monad/i18n';
import { enMessages, zhMessages } from '@monad/i18n/messages';

const ACP_GUIDANCE_LOCALE_PACKS: LocalePack[] = [
  { locale: 'en', name: 'English', messages: enMessages },
  { locale: 'zh', name: '简体中文', messages: zhMessages }
];
const defaultAcpGuidanceT = createI18n({ locale: 'en', packs: ACP_GUIDANCE_LOCALE_PACKS }).t;

// Common auth-failure fingerprints in adapter error messages — the sub-agent started fine (ACP handshake
// completed) but its internal API call was rejected with 401 or equivalent.
const AUTH_ERROR_PATTERNS = [
  /401/i,
  /403/i,
  /authentication/i,
  /unauthorized/i,
  /invalid.*(?:api|auth).*(?:key|credential|token)/i,
  /not logged in/i,
  /Failed to authenticate/i
];

function isAuthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return AUTH_ERROR_PATTERNS.some((p) => p.test(msg));
}

/** Return a user-facing hint for fixing an ACP agent error, or null if no specific guidance applies. */
export function acpAuthGuidance(err: unknown, spec: AcpAgentConfig, translate?: Translate): string | null {
  if (!isAuthError(err)) return null;
  const t = translate ?? defaultAcpGuidanceT;
  const name = spec.name;
  const isClaude = name === 'claude-code' || /\bclaude\b/i.test(spec.command);
  const isCodex = name === 'codex' || /\bcodex\b/i.test(spec.command);
  const lines: string[] = [];
  const envRefExample = (key: string) => t('web.acp.authGuidance.envRef', { key, ref: `\${env:${key}}` });
  if (isClaude) {
    lines.push(t('web.acp.authGuidance.claudeIntro'));
    lines.push(envRefExample('ANTHROPIC_API_KEY'));
    lines.push(t('web.acp.authGuidance.claudeLogin'));
  } else if (isCodex) {
    lines.push(t('web.acp.authGuidance.codexIntro'));
    lines.push(envRefExample('OPENAI_API_KEY'));
    lines.push(t('web.acp.authGuidance.codexLogin'));
  } else {
    lines.push(t('web.acp.authGuidance.generic'));
  }
  return lines.join('\n');
}

// The actionable "couldn't drive the adapter" error, shared by the spawn + prompt failure paths.
export function adapterFailureError(name: string, exitCode: number | null, cause: unknown): Error {
  const exited = exitCode != null ? ` (adapter exited with code ${exitCode})` : '';
  const why = cause instanceof Error ? cause.message : String(cause);
  const suffix = isAuthError(cause)
    ? '— API credentials were rejected (the adapter is installed but authentication failed)'
    : '— ensure the adapter is installed and you are signed in';
  return new Error(`failed to run external agent "${name}"${exited}: ${why} ${suffix}`);
}
