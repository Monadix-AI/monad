import type { CommandDef } from './types.ts';

import { CliError, EXIT } from './types.ts';

const GLOBAL_FLAGS = [
  '--help',
  '--version',
  '--json',
  '--quiet',
  '--verbose',
  '--no-color',
  '--yes',
  '--no-input',
  '-o',
  '--output',
  '--port',
  '--host',
  '--token',
  '--debug'
];

// Second-level subcommands per group command. Kept here (not derived) so the generator stays a
// pure string builder with no import cycle into the command registry.
const SUBCOMMANDS: Record<string, string[]> = {
  session: ['new', 'list', 'show', 'send', 'watch', 'search', 'branch', 'restore', 'reset', 'abort', 'rm'],
  model: ['list', 'set', 'rm', 'use', 'test'],
  provider: ['list', 'set', 'remove', 'models'],
  credential: ['list', 'add', 'remove', 'test'],
  config: ['get', 'set', 'list', 'path', 'edit'],
  skill: ['list', 'install', 'remove', 'new', 'validate'],
  atom: ['list', 'install', 'remove'],
  completion: ['bash', 'zsh', 'fish', 'install'],
  tls: ['renew', 'show', 'trust']
};

const SKILL_SCOPE_VALUES = ['runtime', 'global', 'atom-pack', 'agent'] as const;
const SKILL_COMMAND_FLAGS = ['--scope'];

/** Top-level tokens (canonical names + user-facing aliases). Lazy import avoids the index.ts ⇄
 *  completion.ts cycle; `__`-prefixed internal commands (e.g. __complete) are excluded. */
async function commandTokens(): Promise<string[]> {
  const { commands } = await import('./index.ts');
  return [...new Set(commands.flatMap((c) => [c.name, ...(c.aliases ?? [])]))]
    .filter((n) => !n.startsWith('__'))
    .sort();
}

// Commands whose third positional is a dynamic value resolved live via `monad __complete`.
const DYNAMIC = {
  sessions: ['session'],
  providers: ['provider', 'credential'],
  'config-keys': ['config']
} as const;

function bash(words: string): string {
  const subCases = Object.entries(SUBCOMMANDS)
    .map(([cmd, subs]) => `      ${cmd}) COMPREPLY=( $(compgen -W "${subs.join(' ')}" -- "$cur") );;`)
    .join('\n');
  const dynCases = Object.entries(DYNAMIC)
    .map(([type, cmds]) => `    ${cmds.join('|')}) vals="$(monad __complete ${type} 2>/dev/null)" ;;`)
    .join('\n');
  return `# monad bash completion — eval "$(monad completion bash)"
_monad() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" cmd="\${COMP_WORDS[1]}" prev="\${COMP_WORDS[COMP_CWORD-1]}" vals=""
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${words}" -- "$cur") )
    return
  fi
  if [ "$COMP_CWORD" -eq 2 ]; then
    case "$cmd" in
${subCases}
      *) COMPREPLY=( $(compgen -W "${GLOBAL_FLAGS.join(' ')}" -- "$cur") );;
    esac
    return
  fi
  case "$cmd" in
${dynCases}
    skill)
      if [ "$prev" = "--scope" ]; then
        COMPREPLY=( $(compgen -W "${SKILL_SCOPE_VALUES.join(' ')}" -- "$cur") )
        return
      else
        vals="${GLOBAL_FLAGS.join(' ')} ${SKILL_COMMAND_FLAGS.join(' ')}"
      fi
      ;;
    *) vals="${GLOBAL_FLAGS.join(' ')}" ;;
  esac
  COMPREPLY=( $(compgen -W "$vals" -- "$cur") )
}
complete -F _monad monad
`;
}

function zsh(words: string): string {
  const subCases = Object.entries(SUBCOMMANDS)
    .map(([cmd, subs]) => `      ${cmd}) compadd ${subs.join(' ')} ;;`)
    .join('\n');
  const dynCases = Object.entries(DYNAMIC)
    .map(([type, cmds]) => `      ${cmds.join('|')}) compadd \${(f)"$(monad __complete ${type} 2>/dev/null)"} ;;`)
    .join('\n');
  return `#compdef monad
# monad zsh completion — eval "$(monad completion zsh)"
_monad() {
  local prev="\${words[CURRENT-1]}"
  if (( CURRENT == 2 )); then
    compadd ${words}
  elif (( CURRENT == 3 )); then
    case "\${words[2]}" in
${subCases}
      *) compadd ${GLOBAL_FLAGS.join(' ')} ;;
    esac
  else
    case "\${words[2]}" in
${dynCases}
      skill)
        if [[ "$prev" == "--scope" ]]; then
          compadd ${SKILL_SCOPE_VALUES.join(' ')}
        else
          compadd ${GLOBAL_FLAGS.join(' ')} ${SKILL_COMMAND_FLAGS.join(' ')}
        fi
        ;;
      *) compadd ${GLOBAL_FLAGS.join(' ')} ;;
    esac
  fi
}
compdef _monad monad
`;
}

async function fish(): Promise<string> {
  const tokens = await commandTokens();
  const top = tokens.map((n) => `complete -c monad -n __fish_use_subcommand -a ${n}`);
  const subs = Object.entries(SUBCOMMANDS).flatMap(([cmd, list]) =>
    list.map((s) => `complete -c monad -n "__fish_seen_subcommand_from ${cmd}" -a ${s}`)
  );
  const dyn = Object.entries(DYNAMIC).flatMap(([type, cmds]) =>
    cmds.map(
      (c) => `complete -c monad -n "__fish_seen_subcommand_from ${c}" -a "(monad __complete ${type} 2>/dev/null)"`
    )
  );
  const flags = GLOBAL_FLAGS.map((f) => `complete -c monad -l ${f.replace(/^--/, '')}`);
  const skillFlags = SKILL_COMMAND_FLAGS.map(
    (f) => `complete -c monad -n "__fish_seen_subcommand_from skill" -l ${f.replace(/^--/, '')}`
  );
  const skillScopeValues = `complete -c monad -n "__fish_seen_subcommand_from skill; and __fish_prev_arg -q --scope" -a "${SKILL_SCOPE_VALUES.join(
    ' '
  )}"`;
  return `# monad fish completion — monad completion fish | source\n${[
    ...top,
    ...subs,
    ...dyn,
    ...flags,
    ...skillFlags,
    skillScopeValues
  ].join('\n')}\n`;
}

const INSTALL_HINTS: Record<string, string> = {
  bash: '# add to ~/.bashrc:\neval "$(monad completion bash)"',
  zsh: '# add to ~/.zshrc:\neval "$(monad completion zsh)"',
  fish: '# run once:\nmonad completion fish > ~/.config/fish/completions/monad.fish'
};

export const command: CommandDef = {
  local: true,
  name: 'completion',
  synopsis: 'completion <bash|zsh|fish|install>',
  description: 'output a shell completion script (or `install <shell>` for setup instructions)',
  descriptionKey: 'cli.cmd.completion.desc',
  async run({ positionals }) {
    const [shell, target] = positionals;

    if (shell === 'install') {
      const hint = target && INSTALL_HINTS[target];
      if (!hint) throw new CliError('usage: monad completion install <bash|zsh|fish>', EXIT.USAGE);
      process.stdout.write(`${hint}\n`);
      return;
    }

    const words = (await commandTokens()).join(' ');
    const script =
      shell === 'bash' ? bash(words) : shell === 'zsh' ? zsh(words) : shell === 'fish' ? await fish() : null;
    if (script === null) throw new CliError('usage: monad completion <bash|zsh|fish|install>', EXIT.USAGE);
    process.stdout.write(script);
  }
};
