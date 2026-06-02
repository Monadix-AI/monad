import type { CommandItem } from '@monad/protocol';
import type { EffectiveAgentMemoryPolicy } from '#/services/memory/policy.ts';

type MemoryCommandMessageKey = 'cmd.memoryDisabledForAgent' | 'cmd.memoryAdvancedRequired' | 'cmd.memoryLevelRequired';

type MemoryCommandDecision = { allowed: true } | { allowed: false; messageKey: MemoryCommandMessageKey };

const MEMORY_COMMANDS = new Set(['memory', 'consolidate', 'why', 'check-memory']);

function commandTarget(commandName: string, args: string): { command: string; args: string } | null {
  if (!MEMORY_COMMANDS.has(commandName)) return null;
  if (commandName !== 'memory') return { command: commandName, args };
  const [subcommand = '', ...rest] = args.trim().split(/\s+/);
  return {
    command: subcommand === 'check' ? 'check-memory' : subcommand,
    args: rest.join(' ')
  };
}

export function memoryCommandRequiredLevel(commandName: string, args: string): 1 | 2 | 3 {
  const target = commandTarget(commandName, args);
  if (!target) return 1;
  if (target.command === 'why' || target.command === 'check-memory') return 3;
  if (target.command !== 'consolidate') return 1;
  const requested = Number.parseInt(target.args.trim(), 10);
  return requested >= 1 && requested <= 3 ? (requested as 1 | 2 | 3) : 1;
}

export function memoryCommandDecision(
  commandName: string,
  args: string,
  policy: EffectiveAgentMemoryPolicy
): MemoryCommandDecision {
  if (!MEMORY_COMMANDS.has(commandName)) return { allowed: true };
  if (policy.effectiveLevel === 0) return { allowed: false, messageKey: 'cmd.memoryDisabledForAgent' };
  const required = memoryCommandRequiredLevel(commandName, args);
  if (required <= policy.effectiveLevel) return { allowed: true };
  return {
    allowed: false,
    messageKey: policy.advanced ? 'cmd.memoryLevelRequired' : 'cmd.memoryAdvancedRequired'
  };
}

export function applyMemoryCommandDiscovery(
  commands: CommandItem[],
  policy: EffectiveAgentMemoryPolicy
): CommandItem[] {
  return commands.map((command) => {
    if (!MEMORY_COMMANDS.has(command.id)) return command;
    if (policy.effectiveLevel === 0) return { ...command, enabled: false };
    if (command.id === 'why' || command.id === 'check-memory') {
      return { ...command, enabled: policy.effectiveLevel >= 3 };
    }
    if (command.id !== 'memory') return command;
    return {
      ...command,
      subcommands: command.subcommands?.filter(
        (subcommand) => subcommand.id === 'consolidate' || policy.effectiveLevel >= 3
      )
    };
  });
}
