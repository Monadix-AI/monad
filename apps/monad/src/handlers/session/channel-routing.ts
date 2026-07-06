interface ChannelTargetMention {
  id: string;
  name: string;
  agentName?: string;
  nativeCliAgentName?: string;
}

export type ChannelRouteAction =
  | { kind: 'none' }
  | {
      kind: 'send';
      text: string;
      displayText?: string;
      generate?: boolean;
      direct?: boolean;
      targetMention?: ChannelTargetMention;
    }
  | {
      kind: 'forward-acp';
      agentName: string;
      text: string;
      displayText?: string;
      direct?: boolean;
      targetMention?: ChannelTargetMention;
    }
  | {
      kind: 'forward-native-cli';
      agentName: string;
      text: string;
      displayText?: string;
      direct?: boolean;
      targetMention?: ChannelTargetMention;
    };

export function routeChannelMessage({
  text,
  acpAgentNames,
  nativeCliAgentNames = []
}: {
  text: string;
  acpAgentNames: readonly string[];
  nativeCliAgentNames?: readonly string[];
}): ChannelRouteAction {
  const trimmed = text.trim();
  if (!trimmed) return { kind: 'none' };

  const mentions = channelMentions(trimmed);
  const singleMention = mentions.length === 1 ? mentions[0] : undefined;
  const singleTarget = singleMention ? targetMention(singleMention, acpAgentNames, nativeCliAgentNames) : undefined;

  if (singleTarget) {
    const rest = singleMention ? withoutMention(trimmed, singleMention).trim() : '';
    if (singleTarget.agentName) {
      return {
        kind: 'forward-acp',
        agentName: singleTarget.agentName,
        text: rest || trimmed,
        displayText: trimmed,
        direct: true
      };
    }
    if (singleTarget.nativeCliAgentName) {
      return {
        kind: 'forward-native-cli',
        agentName: singleTarget.nativeCliAgentName,
        text: rest || trimmed,
        displayText: trimmed,
        direct: true
      };
    }
    return { kind: 'send', text: rest || trimmed, displayText: trimmed, direct: true };
  }

  return { kind: 'send', text: trimmed, generate: trimmed.startsWith('/') };
}

function targetMention(
  mention: { name: string; id: string },
  acpAgentNames: readonly string[],
  nativeCliAgentNames: readonly string[]
): ChannelTargetMention | undefined {
  const acpName = mention.id.startsWith('acp:') ? mention.id.slice(4) : undefined;
  if (acpName && acpAgentNames.includes(acpName)) return { id: mention.id, name: mention.name, agentName: acpName };
  const nativeCliName = mention.id.startsWith('native-cli:') ? mention.id.slice('native-cli:'.length) : undefined;
  if (nativeCliName && nativeCliAgentNames.includes(nativeCliName)) {
    return { id: mention.id, name: mention.name, nativeCliAgentName: nativeCliName };
  }
  if (mention.id === 'monad' || mention.id.startsWith('agent:')) return { id: mention.id, name: mention.name };
  return undefined;
}

function channelMentions(text: string): Array<{ name: string; id: string; start: number; end: number }> {
  const mentions: Array<{ name: string; id: string; start: number; end: number }> = [];
  for (const match of text.matchAll(/@\[name="((?:\\.|[^"\\])*)"\s+id="((?:\\.|[^"\\])*)"\]/g)) {
    const start = match.index ?? 0;
    mentions.push({
      name: unescapeMentionValue(match[1] ?? ''),
      id: unescapeMentionValue(match[2] ?? ''),
      start,
      end: start + match[0].length
    });
  }
  return mentions;
}

function withoutMention(text: string, mention: { start: number; end: number }): string {
  return `${text.slice(0, mention.start)}${text.slice(mention.end)}`.replace(/\s+/g, ' ');
}

function unescapeMentionValue(value: string): string {
  return value.replace(/\\(["\\])/g, '$1');
}
