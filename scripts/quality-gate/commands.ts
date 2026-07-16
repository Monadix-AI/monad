export type QualityGateMode = 'check' | 'fix' | 'precommit';
export type QualityGatePhase = 'check' | 'fix' | 'prepare';

export interface QualityGateCommand {
  argv: string[];
  id: string;
  label: string;
  mutatesTrackedFiles: boolean;
  phase: QualityGatePhase;
}

const command = (
  id: string,
  label: string,
  phase: QualityGatePhase,
  argv: string[],
  mutatesTrackedFiles = false
): QualityGateCommand => ({ argv, id, label, mutatesTrackedFiles, phase });

function fixCommands(stagedFiles: string[]): QualityGateCommand[] {
  const biomeTargets = stagedFiles.length > 0 ? stagedFiles : ['.'];
  return [
    command('syncpack-format', 'syncpack format', 'fix', ['bun', 'run', 'syncpack:format'], true),
    command(
      'biome-fix',
      'Biome autofix',
      'fix',
      [
        'bun',
        'biome',
        'check',
        '--write',
        '--unsafe',
        '--no-errors-on-unmatched',
        '--files-ignore-unknown=true',
        ...biomeTargets
      ],
      true
    )
  ];
}

function prepareCommands(): QualityGateCommand[] {
  return [
    command('agents-sync', 'agent instructions', 'prepare', ['bun', 'run', 'agents:sync']),
    command('i18n-types', 'i18n generated types', 'prepare', ['bun', 'run', 'i18n:types']),
    command('typecheck-prepare', 'typecheck generated inputs', 'prepare', ['bun', 'run', 'typecheck:prepare'])
  ];
}

function checkCommands(): QualityGateCommand[] {
  return [
    command('biome', 'Biome', 'check', ['bun', 'run', 'lint:check']),
    command('syncpack', 'syncpack', 'check', ['bun', 'run', 'syncpack:lint']),
    command('knip', 'knip', 'check', ['bun', 'run', 'knip']),
    command('dependency-directions', 'dependency directions', 'check', ['bun', 'run', 'check:deps']),
    command('test-assertions', 'test assertion quality', 'check', ['bun', 'run', 'check:test-assertions']),
    command('agents', 'agent instruction generation', 'check', ['bun', 'run', 'agents:check']),
    command('i18n', 'i18n catalog drift', 'check', ['bun', 'run', 'i18n:check']),
    command('database-history', 'database migration history', 'check', ['bun', 'run', 'db:check']),
    command('database-drift', 'database migration drift', 'check', ['bun', 'run', 'db:drift']),
    command('typecheck', 'TypeScript', 'check', ['bun', 'run', 'typecheck:check'])
  ];
}

export function qualityGateCommands(mode: QualityGateMode, stagedFiles: string[] = []): QualityGateCommand[] {
  if (mode === 'fix') return [...fixCommands(stagedFiles), ...prepareCommands()];
  return checkCommands();
}
