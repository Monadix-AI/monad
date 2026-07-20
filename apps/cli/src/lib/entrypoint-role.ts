import { basename } from 'node:path';

const ROLE_SUBCOMMANDS: Record<string, string> = {
  'monad-daemon': 'daemon',
  'monad-restart': 'daemon-supervisor',
  'monad-watchdog': '--daemon-child-supervisor'
};

export function resolveEntrypointSubcommand(argv: readonly string[], execPath: string): string | undefined {
  const explicit = argv[2];
  if (explicit) return explicit;

  for (const candidate of [execPath, argv[0], argv[1]]) {
    const subcommand = ROLE_SUBCOMMANDS[basename(candidate ?? '')];
    if (subcommand) return subcommand;
  }
  return undefined;
}
