import type { ChannelResponseNextTarget } from '@monad/protocol';
import type { ManagedNativeCliProjectMember } from '@/handlers/session/handlers/messaging-members.ts';

export interface ManagedNativeCliProjectMessageSender {
  kind: 'human' | 'native-cli-agent' | 'agent' | 'system';
  name: string;
  id?: string;
}

export function nativeCliInputText(input: string): string {
  return input.endsWith('\n') ? input : `${input}\n`;
}

export function normalizeManagedNativeCliDirectTarget(to: string): string {
  return to.startsWith('native-cli:') ? to.slice('native-cli:'.length) : to;
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

function managedNativeCliSenderMentionId(sender: ManagedNativeCliProjectMessageSender): string {
  if (sender.kind === 'native-cli-agent') {
    return sender.id?.startsWith('native-cli:') ? sender.id : `native-cli:${sender.id ?? sender.name}`;
  }
  if (sender.kind === 'agent') {
    return sender.id?.startsWith('agent:') ? sender.id : `agent:${sender.id ?? sender.name}`;
  }
  if (sender.kind === 'human') return sender.id ?? 'human';
  return sender.id ?? sender.name;
}

function managedNativeCliSenderMentionToken(sender?: ManagedNativeCliProjectMessageSender): string | null {
  if (!sender?.name) return null;
  const id = managedNativeCliSenderMentionId(sender);
  return `@[name="${mentionTokenValue(sender.name)}" id="${mentionTokenValue(id)}"]`;
}

export function managedNativeCliInboxNotice(
  _member: ManagedNativeCliProjectMember,
  text: string,
  sender?: ManagedNativeCliProjectMessageSender
): string {
  const senderMention = managedNativeCliSenderMentionToken(sender);
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

export function managedNativeCliBusyInboxNotice(
  _member: ManagedNativeCliProjectMember,
  sender?: ManagedNativeCliProjectMessageSender
): string {
  const senderMention = managedNativeCliSenderMentionToken(sender);
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

export function managedNativeCliDirectNotice({
  member: _member,
  fromAgentName,
  text
}: {
  member: ManagedNativeCliProjectMember;
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

export function managedNativeCliResumeRecoveryNotice(provider: string, notice: string): string {
  void provider;
  return [
    'Provider session resume failed. Monad started a fresh managed project runtime.',
    'Follow your managed runtime instructions to restore context before replying.',
    '',
    notice
  ].join('\n');
}
