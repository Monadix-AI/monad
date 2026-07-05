import type { ChannelResponseNextTarget, NativeCliProvider } from '@monad/protocol';
import type { ManagedNativeCliProjectMember } from '@/handlers/session/handlers/messaging-members.ts';

import { findNativeCliProviderAdapter } from '@/services/native-cli/index.ts';
import { managedProjectMonadCliCommand } from '@/services/native-cli/managed-project.ts';

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

function providerUsesMcpProjectBridge(provider: string): boolean {
  return findNativeCliProviderAdapter(provider as NativeCliProvider)?.managedRuntime?.usesManagedMcpBridge ?? false;
}

function usesMcpProjectBridge(member: ManagedNativeCliProjectMember): boolean {
  return providerUsesMcpProjectBridge(member.spec.provider);
}

function managedNativeCliProjectCommunicationInstructions(member: ManagedNativeCliProjectMember): string[] {
  const monadCliCommand = managedProjectMonadCliCommand();
  if (usesMcpProjectBridge(member)) {
    return [
      'Call the `project_inbox_check` or `project_read` tools from the `monad` MCP server before answering if you need more context.',
      'If a public response is appropriate, post it with the `project_post` tool from the `monad` MCP server.',
      'Every `project_post`, `project_ask`, or `agent_send` call must include a stable `requestId`; reuse it only when retrying the same intended action.',
      'To share local files for humans to read, pass `attachments` with local file paths. An `[Attachment ... - file at <path>]` marker in a message means the full content is in that file; read it directly if you need it.',
      'Use the `agent_send` tool from the `monad` MCP server only for private/direct conversation.'
    ];
  }
  return [
    `Run \`${monadCliCommand} project inbox check\` or \`${monadCliCommand} project read\` before answering if you need more context.`,
    `If a public response is appropriate, post it with \`${monadCliCommand} project post -\` and stdin.`,
    `Pass message text through a quoted heredoc, for example \`${monadCliCommand} project post - <<'MONAD_MESSAGE'\`. Do not pass message text inline in a shell command because backticks, $(), and quotes will be interpreted by the shell before Monad receives them.`,
    'To share local files for humans to read, add `--file <path>` (repeatable). An `[Attachment ... - file at <path>]` marker in a message means the full content is in that file; read it directly if you need it.',
    `Use \`${monadCliCommand} agent send --to <agent|human> -\` with stdin only for private/direct conversation.`
  ];
}

function managedNativeCliBusyCommunicationInstructions(member: ManagedNativeCliProjectMember): string[] {
  const monadCliCommand = managedProjectMonadCliCommand();
  if (usesMcpProjectBridge(member)) {
    return [
      'You are already running. Immediately call the `project_inbox_check` tool from the `monad` MCP server before deciding whether to reply. This notice does not include the message body; the inbox item is the source of truth.',
      'If `project_inbox_check` from the `monad` MCP server returns no items, call the `project_read` tool from the same server before deciding whether to reply.',
      'If a public response is appropriate, post it with the `project_post` tool from the `monad` MCP server.',
      'Every `project_post`, `project_ask`, or `agent_send` call must include a stable `requestId`; reuse it only when retrying the same intended action.',
      'To share local files for humans to read, pass `attachments` with local file paths. An `[Attachment ... - file at <path>]` marker in a message means the full content is in that file; read it directly if you need it.',
      'Use the `agent_send` tool from the `monad` MCP server only for private/direct conversation.'
    ];
  }
  return [
    `You are already running. Immediately run \`${monadCliCommand} project inbox check\` before deciding whether to reply. This notice does not include the message body; the inbox item is the source of truth.`,
    `If \`${monadCliCommand} project inbox check\` returns no items, run \`${monadCliCommand} project read\` before deciding whether to reply.`,
    `If a public response is appropriate, post it with \`${monadCliCommand} project post -\` and stdin.`,
    `Pass message text through a quoted heredoc, for example \`${monadCliCommand} project post - <<'MONAD_MESSAGE'\`. Do not pass message text inline in a shell command because backticks, $(), and quotes will be interpreted by the shell before Monad receives them.`,
    'To share local files for humans to read, add `--file <path>` (repeatable). An `[Attachment ... - file at <path>]` marker in a message means the full content is in that file; read it directly if you need it.',
    `Use \`${monadCliCommand} agent send --to <agent|human> -\` with stdin only for private/direct conversation.`
  ];
}

function managedNativeCliSharedProjectInstructions(member: ManagedNativeCliProjectMember): string[] {
  const monadCliCommand = managedProjectMonadCliCommand();
  const syncInstruction = usesMcpProjectBridge(member)
    ? 'During long-running work, periodically call the `project_inbox_check` or `project_read` tools from the `monad` MCP server before posting so you stay synchronized with other members.'
    : `During long-running work, periodically run \`${monadCliCommand} project inbox check\` or \`${monadCliCommand} project read\` before posting so you stay synchronized with other members.`;
  return [
    'For any non-trivial task, first acknowledge ownership in the project room before doing longer work.',
    'During long-running work, post brief progress updates at meaningful milestones, blockers, input needs, or direction changes.',
    syncInstruction,
    "Do not repeat another member's answer, status update, or plan. Add only new information, corrections, concrete progress, or a clearly useful next step.",
    'To mention someone publicly, use the strict capsule token `@[name="display name" id="participant id"]`. Plain `@name` is ordinary text.',
    'Treat human messages as high-priority project input: be more proactive and reply unless the message is clearly informational, already handled, or outside your role.',
    'For agent/system messages, reply only when you can add concrete task value.',
    'Do not make small talk. Only post when your response adds task-relevant value.',
    'When posting to the project room, be vivid, friendly, helpful, and warm in tone while staying concise and avoiding filler.'
  ];
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
    ...managedNativeCliProjectCommunicationInstructions(member),
    ...managedNativeCliSharedProjectInstructions(member)
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
    ...managedNativeCliBusyCommunicationInstructions(member),
    ...managedNativeCliSharedProjectInstructions(member)
  ].join('\n');
}

export function managedNativeCliDirectNotice({
  member,
  fromAgentName,
  text
}: {
  member: ManagedNativeCliProjectMember;
  fromAgentName: string;
  text: string;
}): string {
  const monadCliCommand = managedProjectMonadCliCommand();
  const instructions = usesMcpProjectBridge(member)
    ? [
        `Use the \`agent_read\` tool from the \`monad\` MCP server with \`with: "${fromAgentName}"\` to read the private conversation.`,
        `Reply privately with the \`agent_send\` tool from the \`monad\` MCP server and \`to: "${fromAgentName}"\`.`,
        'Every `agent_send` call must include a stable `requestId`; reuse it only when retrying the same intended direct message.',
        'Use the `project_post` tool from the `monad` MCP server only when you want to speak publicly in the Workplace Project.'
      ]
    : [
        `Use \`${monadCliCommand} agent read --with ${fromAgentName}\` to read the private conversation.`,
        `Reply privately with \`${monadCliCommand} agent send --to ${fromAgentName} -\` and stdin.`,
        `Use \`${monadCliCommand} project post\` only when you want to speak publicly in the Workplace Project.`
      ];
  return [
    `New direct/private message from ${fromAgentName} is available.`,
    '',
    text,
    '',
    ...instructions,
    'An `[Attachment ... - file at <path>]` marker in the message means the full content is in that file; read it directly if you need it.',
    'Terminal stdout/stderr is diagnostic output only. It is not a Workplace Project message.'
  ].join('\n');
}

export function managedNativeCliResumeRecoveryNotice(provider: string, notice: string): string {
  const monadCliCommand = managedProjectMonadCliCommand();
  const restoreInstruction = providerUsesMcpProjectBridge(provider)
    ? 'Before replying, restore context from MEMORY.md and call the `project_read` tool from the `monad` MCP server.'
    : `Before replying, restore context from MEMORY.md and \`${monadCliCommand} project read\`.`;
  return [
    'Provider session resume failed. Monad started a fresh managed project runtime.',
    restoreInstruction,
    '',
    notice
  ].join('\n');
}
