import { expect, test } from 'bun:test';

import {
  buildToolBackendsRequest,
  createCredentialEdit,
  markCredentialForRemoval,
  resetCredentialEdit,
  setCredentialReplacement,
  type ToolBackendsFormState
} from '#/features/studio/capabilities-settings/tool-backends-request';

const createFormState = (): ToolBackendsFormState => ({
  webSearchProvider: 'brave',
  braveApiKey: createCredentialEdit(),
  codeExecBackend: 'e2b',
  e2bApiKey: createCredentialEdit(),
  dockerImage: 'ubuntu:22.04',
  emailEnabled: true,
  emailBackend: 'auto',
  emailFrom: 'sender@example.com',
  resendApiKey: createCredentialEdit(),
  smtpEnabled: true,
  smtpHost: 'smtp.example.com',
  smtpPort: '587',
  smtpUser: 'mailer@example.com',
  smtpPass: createCredentialEdit(),
  smtpSecure: true,
  smtpClientName: 'Monad'
});

test('removing the Brave credential emits remove while retaining the selected search provider', () => {
  const state = createFormState();
  state.braveApiKey = markCredentialForRemoval(setCredentialReplacement(state.braveApiKey, 'replacement'));

  expect(state.braveApiKey).toEqual({ value: '', pendingRemoval: true });
  expect(buildToolBackendsRequest(state)).toEqual({
    webSearch: {
      provider: 'brave',
      braveApiKey: { action: 'remove' }
    },
    email: {
      backend: 'auto',
      from: 'sender@example.com',
      smtp: {
        action: 'replace',
        value: {
          host: 'smtp.example.com',
          port: 587,
          user: 'mailer@example.com',
          secure: true,
          clientName: 'Monad'
        }
      }
    },
    codeExec: {
      backend: 'e2b',
      dockerImage: 'ubuntu:22.04'
    }
  });
});

test('removing the E2B credential emits remove while retaining code execution settings', () => {
  const state = createFormState();
  state.e2bApiKey = markCredentialForRemoval(setCredentialReplacement(state.e2bApiKey, 'replacement'));

  expect(state.e2bApiKey).toEqual({ value: '', pendingRemoval: true });
  expect(buildToolBackendsRequest(state)).toEqual({
    webSearch: {
      provider: 'brave'
    },
    email: {
      backend: 'auto',
      from: 'sender@example.com',
      smtp: {
        action: 'replace',
        value: {
          host: 'smtp.example.com',
          port: 587,
          user: 'mailer@example.com',
          secure: true,
          clientName: 'Monad'
        }
      }
    },
    codeExec: {
      backend: 'e2b',
      e2bApiKey: { action: 'remove' },
      dockerImage: 'ubuntu:22.04'
    }
  });
});

test('removing the Resend credential emits remove while retaining email and SMTP settings', () => {
  const state = createFormState();
  state.resendApiKey = markCredentialForRemoval(setCredentialReplacement(state.resendApiKey, 'replacement'));

  expect(state.resendApiKey).toEqual({ value: '', pendingRemoval: true });
  expect(buildToolBackendsRequest(state)).toEqual({
    webSearch: {
      provider: 'brave'
    },
    email: {
      backend: 'auto',
      from: 'sender@example.com',
      resendApiKey: { action: 'remove' },
      smtp: {
        action: 'replace',
        value: {
          host: 'smtp.example.com',
          port: 587,
          user: 'mailer@example.com',
          secure: true,
          clientName: 'Monad'
        }
      }
    },
    codeExec: {
      backend: 'e2b',
      dockerImage: 'ubuntu:22.04'
    }
  });
});

test('removing the SMTP password emits remove while retaining the SMTP configuration', () => {
  const state = createFormState();
  state.smtpPass = markCredentialForRemoval(setCredentialReplacement(state.smtpPass, 'replacement'));

  expect(state.smtpPass).toEqual({ value: '', pendingRemoval: true });
  expect(buildToolBackendsRequest(state)).toEqual({
    webSearch: {
      provider: 'brave'
    },
    email: {
      backend: 'auto',
      from: 'sender@example.com',
      smtp: {
        action: 'replace',
        value: {
          host: 'smtp.example.com',
          port: 587,
          user: 'mailer@example.com',
          pass: { action: 'remove' },
          secure: true,
          clientName: 'Monad'
        }
      }
    },
    codeExec: {
      backend: 'e2b',
      dockerImage: 'ubuntu:22.04'
    }
  });
});

test('typing a replacement cancels a pending credential removal', () => {
  const pending = markCredentialForRemoval(createCredentialEdit());

  expect(setCredentialReplacement(pending, 'next-secret')).toEqual({
    value: 'next-secret',
    pendingRemoval: false
  });
});

test('resetting a credential edit discards both replacement and pending removal state', () => {
  const replacement = setCredentialReplacement(createCredentialEdit(), 'next-secret');
  const pendingRemoval = markCredentialForRemoval(replacement);

  expect({
    replacement: resetCredentialEdit(replacement),
    pendingRemoval: resetCredentialEdit(pendingRemoval)
  }).toEqual({
    replacement: { value: '', pendingRemoval: false },
    pendingRemoval: { value: '', pendingRemoval: false }
  });
});
