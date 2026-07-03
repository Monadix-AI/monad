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
  member: ManagedNativeCliProjectMember,
  text: string,
  sender?: ManagedNativeCliProjectMessageSender
): string {
  const senderMention = managedNativeCliSenderMentionToken(sender);
  return [
    'New Workplace Project message is available.',
    'Process this project message now.',
    '',
    `Your display name: ${member.displayName}`,
    `Your runtime agent id: ${member.runtimeAgentName}`,
    `Template agent: ${member.templateAgentName}`,
    `Provider: ${member.spec.provider}`,
    '',
    'Project message metadata:',
    `Sender kind: ${sender?.kind ?? 'unknown'}`,
    `Sender name: ${sender?.name ?? 'unknown'}`,
    ...(sender?.id ? [`Sender id: ${sender.id}`] : []),
    ...(senderMention ? [`Sender mention token: ${senderMention}`] : []),
    '',
    'Project message body:',
    text,
    '',
    'Run `monad project inbox check` or `monad project read` before answering if you need more context.',
    'If a public response is appropriate, post it with `monad project post -` and stdin.',
    "Pass message text through a quoted heredoc, for example `monad project post - <<'MONAD_MESSAGE'`. Do not pass message text inline in a shell command because backticks, `$()`, and quotes will be interpreted by the shell before Monad receives them.",
    'To share local files for humans to read, add `--file <path>` (repeatable). An `[Attachment … — file at <path>]` marker in a message means the full content is in that file; read it directly if you need it.',
    'Use `monad agent send --to <agent|human> -` with stdin only for private/direct conversation.',
    'For any non-trivial task, first acknowledge ownership in the project room before doing longer work.',
    'During long-running work, post brief progress updates at meaningful milestones, blockers, input needs, or direction changes.',
    'During long-running work, periodically run `monad project inbox check` or `monad project read` before posting so you stay synchronized with other members.',
    "Do not repeat another member's answer, status update, or plan. Add only new information, corrections, concrete progress, or a clearly useful next step.",
    'To mention someone publicly, use the strict capsule token `@[name="display name" id="participant id"]`. Plain `@name` is ordinary text.',
    'Treat human messages as high-priority project input: be more proactive and reply unless the message is clearly informational, already handled, or outside your role.',
    'For agent/system messages, reply only when you can add concrete task value.',
    'Do not make small talk. Only post when your response adds task-relevant value.',
    'When posting to the project room, be vivid, friendly, helpful, and warm in tone while staying concise and avoiding filler.'
  ].join('\n');
}

export function managedNativeCliBusyInboxNotice(
  member: ManagedNativeCliProjectMember,
  sender?: ManagedNativeCliProjectMessageSender
): string {
  const senderMention = managedNativeCliSenderMentionToken(sender);
  return [
    'New Workplace Project message is available.',
    'You are being woken to process the pending project inbox now.',
    '',
    `Your display name: ${member.displayName}`,
    `Your runtime agent id: ${member.runtimeAgentName}`,
    `Template agent: ${member.templateAgentName}`,
    `Provider: ${member.spec.provider}`,
    '',
    'Pending message metadata:',
    `Sender kind: ${sender?.kind ?? 'unknown'}`,
    `Sender name: ${sender?.name ?? 'unknown'}`,
    ...(sender?.id ? [`Sender id: ${sender.id}`] : []),
    ...(senderMention ? [`Sender mention token: ${senderMention}`] : []),
    '',
    'You are already running. Immediately run `monad project inbox check` before deciding whether to reply. This notice does not include the message body; the inbox item is the source of truth.',
    'If `monad project inbox check` returns no items, run `monad project read` before deciding whether to reply.',
    'If a public response is appropriate, post it with `monad project post -` and stdin.',
    "Pass message text through a quoted heredoc, for example `monad project post - <<'MONAD_MESSAGE'`. Do not pass message text inline in a shell command because backticks, `$()`, and quotes will be interpreted by the shell before Monad receives them.",
    'To share local files for humans to read, add `--file <path>` (repeatable). An `[Attachment … — file at <path>]` marker in a message means the full content is in that file; read it directly if you need it.',
    'Use `monad agent send --to <agent|human> -` with stdin only for private/direct conversation.',
    'For any non-trivial task, first acknowledge ownership in the project room before doing longer work.',
    'During long-running work, post brief progress updates at meaningful milestones, blockers, input needs, or direction changes.',
    'During long-running work, periodically run `monad project inbox check` or `monad project read` before posting so you stay synchronized with other members.',
    "Do not repeat another member's answer, status update, or plan. Add only new information, corrections, concrete progress, or a clearly useful next step.",
    'To mention someone publicly, use the strict capsule token `@[name="display name" id="participant id"]`. Plain `@name` is ordinary text.',
    'Treat human messages as high-priority project input: be more proactive and reply unless the message is clearly informational, already handled, or outside your role.',
    'For agent/system messages, reply only when you can add concrete task value.',
    'Do not make small talk. Only post when your response adds task-relevant value.',
    'When posting to the project room, be vivid, friendly, helpful, and warm in tone while staying concise and avoiding filler.'
  ].join('\n');
}

export function managedNativeCliDirectNotice({ fromAgentName, text }: { fromAgentName: string; text: string }): string {
  return [
    `New direct/private message from ${fromAgentName} is available.`,
    '',
    text,
    '',
    `Use \`monad agent read --with ${fromAgentName}\` to read the private conversation.`,
    `Reply privately with \`monad agent send --to ${fromAgentName} -\` and stdin.`,
    'An `[Attachment … — file at <path>]` marker in the message means the full content is in that file; read it directly if you need it.',
    'Use `monad project post` only when you want to speak publicly in the Workplace Project.',
    'Terminal stdout/stderr is diagnostic output only. It is not a Workplace Project message.'
  ].join('\n');
}

export function managedNativeCliResumeRecoveryNotice(notice: string): string {
  return [
    'Provider session resume failed. Monad started a fresh managed project runtime.',
    'Before replying, restore context from MEMORY.md and `monad project read`.',
    '',
    notice
  ].join('\n');
}
