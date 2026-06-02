import type { SetToolBackendsRequest } from '@monad/protocol';

export type WebSearchProvider = 'auto' | 'native' | 'brave' | 'ddgs';
export type CodeExecBackend = 'follow-system' | 'docker' | 'e2b';
export type EmailBackend = 'auto' | 'smtp' | 'resend';

export type CredentialEdit = {
  value: string;
  pendingRemoval: boolean;
};

export interface ToolBackendsFormState {
  webSearchProvider: WebSearchProvider;
  braveApiKey: CredentialEdit;
  codeExecBackend: CodeExecBackend;
  e2bApiKey: CredentialEdit;
  dockerImage: string;
  emailEnabled: boolean;
  emailBackend: EmailBackend;
  emailFrom: string;
  resendApiKey: CredentialEdit;
  smtpEnabled: boolean;
  smtpHost: string;
  smtpPort: string;
  smtpUser: string;
  smtpPass: CredentialEdit;
  smtpSecure: boolean;
  smtpClientName: string;
}

export function createCredentialEdit(): CredentialEdit {
  return { value: '', pendingRemoval: false };
}

export function resetCredentialEdit(_edit: CredentialEdit): CredentialEdit {
  return createCredentialEdit();
}

export function markCredentialForRemoval(_edit: CredentialEdit): CredentialEdit {
  return { value: '', pendingRemoval: true };
}

export function setCredentialReplacement(_edit: CredentialEdit, value: string): CredentialEdit {
  return { value, pendingRemoval: false };
}

function credentialUpdate(edit: CredentialEdit) {
  if (edit.pendingRemoval) return { action: 'remove' as const };
  if (edit.value) return { action: 'replace' as const, value: edit.value };
  return undefined;
}

export function buildToolBackendsRequest(state: ToolBackendsFormState): SetToolBackendsRequest {
  const braveApiKey = credentialUpdate(state.braveApiKey);
  const e2bApiKey = credentialUpdate(state.e2bApiKey);
  const resendApiKey = credentialUpdate(state.resendApiKey);
  const smtpPass = credentialUpdate(state.smtpPass);
  const smtp: NonNullable<SetToolBackendsRequest['email']>['smtp'] =
    state.emailEnabled && state.smtpEnabled && state.smtpHost
      ? {
          action: 'replace',
          value: {
            host: state.smtpHost,
            ...(state.smtpPort ? { port: parseInt(state.smtpPort, 10) } : {}),
            ...(state.smtpUser ? { user: state.smtpUser } : {}),
            ...(smtpPass ? { pass: smtpPass } : {}),
            ...(state.smtpSecure ? { secure: true } : {}),
            ...(state.smtpClientName ? { clientName: state.smtpClientName } : {})
          }
        }
      : { action: 'remove' };

  return {
    webSearch: {
      provider: state.webSearchProvider,
      ...(braveApiKey ? { braveApiKey } : {})
    },
    email: state.emailEnabled
      ? {
          backend: state.emailBackend,
          ...(state.emailFrom ? { from: state.emailFrom } : {}),
          ...(resendApiKey ? { resendApiKey } : {}),
          smtp
        }
      : {
          backend: 'auto',
          from: '',
          resendApiKey: { action: 'remove' },
          smtp: { action: 'remove' }
        },
    codeExec: {
      backend: state.codeExecBackend,
      ...(e2bApiKey ? { e2bApiKey } : {}),
      dockerImage: state.dockerImage || null
    }
  };
}
