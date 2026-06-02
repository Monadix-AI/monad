// email_send — pluggable outbound email. Like web_search/code_execute, the default backend
// is the zero-dependency, universal one (SMTP — every provider speaks it); an HTTP provider
// (Resend) can replace it. High-risk: sending mail is irreversible and crosses a trust
// boundary, so the tool routes through the oversight gate like every other send/pay/delete action.
//
// Configuration flows in via configureEmail() (called from main.ts after config load).
// The SMTP wire dialog lives in email-smtp.ts; this file holds the provider-agnostic message
// model, the MIME builder, the Resend backend, and backend selection.

import type { Tool } from '../../types.ts';
import type { SmtpConfig } from './smtp.ts';

import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { toolResult } from '../../types.ts';
import { smtpBackend } from './smtp.ts';

export interface ResolvedEmailConfig {
  backend: 'auto' | 'smtp' | 'resend';
  /** Default sender address. Already resolved — no ${env:NAME} refs. */
  from?: string;
  /** Resend API key (resolved). Present only when backend is 'resend' or 'auto' with key set. */
  resendApiKey?: string;
  /** SMTP config (resolved — pass is the plaintext password, not a ref). */
  smtp?: SmtpConfig;
}

let _emailConfig: ResolvedEmailConfig | null = null;

/** Call once after config load (and secret resolution) to wire up email from config.agent.tools.email. */
export function configureEmail(cfg: ResolvedEmailConfig): void {
  _emailConfig = cfg;
}

export interface EmailMessage {
  to: string[];
  subject: string;
  body: string;
  from?: string; // backend supplies a default when omitted (SMTP user / Resend default)
  cc?: string[];
  bcc?: string[];
}

export interface EmailSendResult {
  /** Provider/message id when the backend returns one (Resend), else undefined (SMTP 250 ok). */
  id?: string;
  backend: string;
}

export class EmailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailError';
  }
}

export interface EmailBackend {
  name: string;
  send(msg: Required<Pick<EmailMessage, 'from' | 'to' | 'subject' | 'body'>> & EmailMessage): Promise<EmailSendResult>;
}

const ADDR = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Reject anything that isn't a bare addr-spec — guards against header injection via the
 * agent-supplied recipient/from fields (a newline could smuggle extra SMTP headers). */
export function assertAddress(addr: string): string {
  if (!ADDR.test(addr) || /[\r\n]/.test(addr)) throw new EmailError(`invalid email address: ${JSON.stringify(addr)}`);
  return addr;
}

// Anything outside printable ASCII (0x20-0x7e) needs RFC 2047 encoding in a header.
const NON_ASCII = /[^\x20-\x7e]/;

/** RFC 2047 encoded-word for a header value that may contain UTF-8 (e.g. the subject). */
function encodeHeaderWord(value: string): string {
  if (!NON_ASCII.test(value)) return value.replace(/[\r\n]/g, ' ');
  return `=?UTF-8?B?${Buffer.from(value, 'utf-8').toString('base64')}?=`;
}

/** Build an RFC 5322 message with a base64 UTF-8 body. base64 output contains no '.'-leading
 * lines, so SMTP dot-stuffing is unnecessary. `date` is injectable for deterministic tests. */
export function buildMimeMessage(
  msg: Required<Pick<EmailMessage, 'from' | 'to' | 'subject' | 'body'>> & EmailMessage,
  opts: { date?: string; messageId?: string } = {}
): string {
  const from = assertAddress(msg.from);
  const to = msg.to.map(assertAddress);
  const cc = msg.cc?.map(assertAddress) ?? [];
  const date = opts.date ?? new Date().toUTCString();
  const domain = from.split('@')[1] ?? 'localhost';
  const messageId = opts.messageId ?? `<${randomUUID()}@${domain}>`;
  const bodyB64 = Buffer.from(msg.body, 'utf-8')
    .toString('base64')
    .replace(/(.{76})/g, '$1\r\n');

  const headers = [
    `From: ${from}`,
    `To: ${to.join(', ')}`,
    ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
    `Subject: ${encodeHeaderWord(msg.subject)}`,
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64'
  ];
  return `${headers.join('\r\n')}\r\n\r\n${bodyB64}\r\n`;
}

export function resendBackend(apiKey: string, fetchImpl: typeof fetch = fetch): EmailBackend {
  return {
    name: 'resend',
    async send(msg) {
      const res = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from: assertAddress(msg.from),
          to: msg.to.map(assertAddress),
          cc: msg.cc?.map(assertAddress),
          bcc: msg.bcc?.map(assertAddress),
          subject: msg.subject,
          text: msg.body
        })
      });
      if (!res.ok) {
        throw new EmailError(`resend send failed: ${res.status} ${await res.text().catch(() => '')}`.trim());
      }
      const data = z.object({ id: z.string().optional() }).parse(await res.json().catch(() => ({})));
      return { id: data.id, backend: 'resend' };
    }
  };
}

/** Select backend from the config store (set via configureEmail). Returns null when not configured. */
function selectEmailBackendFromConfig(cfg: ResolvedEmailConfig): EmailBackend | null {
  const { backend, resendApiKey, smtp } = cfg;
  if (backend === 'resend' || (backend === 'auto' && resendApiKey)) {
    if (!resendApiKey) throw new EmailError('email backend is "resend" but no resend.apiKey is configured');
    return resendBackend(resendApiKey);
  }
  if (backend === 'smtp' || (backend === 'auto' && smtp)) {
    if (!smtp) throw new EmailError('email backend is "smtp" but no smtp config is set');
    return smtpBackend(smtp);
  }
  if (backend !== 'auto') throw new EmailError(`unknown email backend "${backend}" (expected "smtp" or "resend")`);
  return null;
}

export function selectEmailBackend(): EmailBackend | null {
  return _emailConfig ? selectEmailBackendFromConfig(_emailConfig) : null;
}

const emailSendInput = z.object({
  to: z.array(z.string()).min(1),
  subject: z.string(),
  body: z.string(),
  from: z.string().optional(),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional()
});

export const emailSendTool: Tool<z.infer<typeof emailSendInput>, EmailSendResult> = {
  name: 'email_send',
  description:
    'Send an email via the configured backend (SMTP or Resend, set via agent.tools.email in config). High-risk: irreversible and crosses a trust boundary.',
  scopes: [{ resource: 'email:send' }],
  highRisk: true,
  inputSchema: emailSendInput,
  run: async (input) => {
    const backend = selectEmailBackend();
    if (!backend) {
      throw new EmailError('no email backend configured — set agent.tools.email in config.json (smtp or resend)');
    }
    const from = input.from ?? _emailConfig?.from;
    if (!from) throw new EmailError('no sender address — pass "from" or set agent.tools.email.from in config');
    return toolResult(await backend.send({ ...input, from }));
  }
};

const emailTools: Tool[] = [emailSendTool as Tool];

import type { ToolModule } from '../contract.ts';
// Uniform module entry. Static module — no boot deps.
export const register: ToolModule = () => emailTools;
