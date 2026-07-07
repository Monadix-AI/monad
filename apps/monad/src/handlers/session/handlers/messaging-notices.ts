import type { ChannelResponseNextTarget } from '@monad/protocol';
import type { ManagedExternalAgentProjectMember } from '@/handlers/session/handlers/messaging-members.ts';

export interface ManagedExternalAgentProjectMessageSender {
  kind: 'human' | 'external-agent' | 'agent' | 'system';
  name: string;
  id?: string;
}

export function externalAgentInputText(input: string): string {
  return input.endsWith('\n') ? input : `${input}\n`;
}

export function normalizeManagedExternalAgentDirectTarget(to: string): string {
  return to.startsWith('external-agent:') ? to.slice('external-agent:'.length) : to;
}

export function channelNextPrompt(target: ChannelResponseNextTarget): string {
  return [
    target.title ? `Task: ${target.title}` : '',
    target.context ? `Context:\n${target.context}` : '',
    target.prompt
  ]
    .filter(Boolean)
    .join('\n\n');
}

function mentionTokenValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function managedExternalAgentSenderMentionId(sender: ManagedExternalAgentProjectMessageSender): string {
  if (sender.kind === 'external-agent') {
    return sender.id?.startsWith('external-agent:') ? sender.id : `external-agent:${sender.id ?? sender.name}`;
  }
  if (sender.kind === 'agent') {
    return sender.id?.startsWith('agent:') ? sender.id : `agent:${sender.id ?? sender.name}`;
  }
  if (sender.kind === 'human') return sender.id ?? 'human';
  return sender.id ?? sender.name;
}

function managedExternalAgentSenderMentionToken(sender?: ManagedExternalAgentProjectMessageSender): string | null {
  if (!sender?.name) return null;
  const id = managedExternalAgentSenderMentionId(sender);
  return `@[name="${mentionTokenValue(sender.name)}" id="${mentionTokenValue(id)}"]`;
}

export function managedExternalAgentInboxNotice(
  _member: ManagedExternalAgentProjectMember,
  text: string,
  sender?: ManagedExternalAgentProjectMessageSender
): string {
  const senderMention = managedExternalAgentSenderMentionToken(sender);
  return [
    'New Workplace Project message is available.',
    'Process this project message now.',
    '',
    'Message metadata:',
    `Sender kind: ${sender?.kind ?? 'unknown'}`,
    `Sender name: ${sender?.name ?? 'unknown'}`,
    ...(sender?.id ? [`Sender id: ${sender.id}`] : []),
    ...(senderMention ? [`Sender mention token: ${senderMention}`] : []),
    '',
    'Project message body:',
    text
  ].join('\n');
}

export function managedExternalAgentBusyInboxNotice(
  _member: ManagedExternalAgentProjectMember,
  sender?: ManagedExternalAgentProjectMessageSender
): string {
  const senderMention = managedExternalAgentSenderMentionToken(sender);
  return [
    'New Workplace Project message is available.',
    'You are being woken to process the pending project inbox now.',
    '',
    'Pending message metadata:',
    `Sender kind: ${sender?.kind ?? 'unknown'}`,
    `Sender name: ${sender?.name ?? 'unknown'}`,
    ...(sender?.id ? [`Sender id: ${sender.id}`] : []),
    ...(senderMention ? [`Sender mention token: ${senderMention}`] : []),
    '',
    'The message body is in your project inbox. Follow your managed runtime instructions to read it before deciding whether to reply.'
  ].join('\n');
}

export function managedExternalAgentDirectNotice({
  member: _member,
  fromAgentName,
  text
}: {
  member: ManagedExternalAgentProjectMember;
  fromAgentName: string;
  text: string;
}): string {
  return [
    `New direct/private message from ${fromAgentName} is available.`,
    '',
    text,
    '',
    'Follow your managed runtime instructions for private/direct messages.'
  ].join('\n');
}

export function managedExternalAgentResumeRecoveryNotice(provider: string, notice: string): string {
  void provider;
  return [
    'Provider session resume failed. Monad started a fresh managed project runtime.',
    'Follow your managed runtime instructions to restore context before replying.',
    '',
    notice
  ].join('\n');
}
