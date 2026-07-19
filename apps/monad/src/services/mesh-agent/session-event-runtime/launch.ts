import type { EncodedTurnInput, MeshAgentProcessLaunchPlan } from '@monad/sdk-atom';

import { isAbsolute, relative, resolve } from 'node:path';

import { validateProcessLaunchPlan } from './validation.ts';

const MAX_TURN_INPUT_BYTES = 1024 * 1024;
const MAX_TURN_VALUES = 1_024;
const MAX_TURN_VALUE_BYTES = 64 * 1024;

export interface MaterializedProcessLaunch {
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
  stdin?: Uint8Array;
}

interface ProcessLaunchArgs {
  executable: string;
  allowedWorkingRoot: string;
  plan: MeshAgentProcessLaunchPlan;
}

function invalid(message: string): never {
  throw new Error(`invalid MeshAgent process launch: ${message}`);
}

export function materializeProcessLaunch(args: ProcessLaunchArgs): MaterializedProcessLaunch {
  if (!isAbsolute(args.executable) || args.executable.includes('\0'))
    invalid('daemon must provide an absolute executable');
  if (!isAbsolute(args.allowedWorkingRoot)) invalid('allowed working root must be absolute');
  const plan = validateProcessLaunchPlan(args.plan);
  const root = resolve(args.allowedWorkingRoot);
  const cwd = resolve(plan.cwd);
  const fromRoot = relative(root, cwd);
  if (
    fromRoot === '..' ||
    fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(fromRoot)
  ) {
    invalid('working directory is outside the allowed root');
  }
  return {
    argv: [args.executable, ...plan.args],
    cwd,
    ...(plan.env ? { env: { ...plan.env } } : {})
  };
}

export function materializeTurnLaunch(
  args: ProcessLaunchArgs & { input: EncodedTurnInput }
): MaterializedProcessLaunch {
  const launch = materializeProcessLaunch(args);
  const input = args.input as EncodedTurnInput;
  if (input.delivery === 'stdin') {
    if (!(input.bytes instanceof Uint8Array)) invalid('stdin turn input must be bytes');
    if (input.bytes.byteLength > MAX_TURN_INPUT_BYTES) invalid(`turn input exceeds ${MAX_TURN_INPUT_BYTES} bytes`);
    return { ...launch, stdin: input.bytes.slice() };
  }
  if (input.delivery !== 'argv-tail' || input.separator !== '--' || !Array.isArray(input.values)) {
    invalid('argv turn input requires a literal -- separator');
  }
  if (input.values.length > MAX_TURN_VALUES) invalid(`turn input exceeds ${MAX_TURN_VALUES} argv values`);
  let totalBytes = 0;
  for (const value of input.values) {
    if (typeof value !== 'string' || value.includes('\0'))
      invalid('argv turn input must contain strings without NUL bytes');
    const bytes = Buffer.byteLength(value);
    if (bytes > MAX_TURN_VALUE_BYTES) invalid('argv turn input value is too large');
    totalBytes += bytes;
  }
  if (totalBytes > MAX_TURN_INPUT_BYTES) invalid(`turn input exceeds ${MAX_TURN_INPUT_BYTES} bytes`);
  return { ...launch, argv: [...launch.argv, '--', ...input.values] };
}
