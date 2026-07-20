import type { MeshAgentProcessLaunchPlan, SessionEventRuntimeDefinition } from '@monad/sdk-atom';

import { isAbsolute } from 'node:path';
import { z } from 'zod';

const MAX_STARTUP_TIMEOUT_MS = 300_000;
const MAX_IDLE_TIMEOUT_MS = 86_400_000;
const MAX_RECONNECT_ATTEMPTS = 100;
const MAX_ARGUMENT_COUNT = 4_096;
const MAX_ARGUMENT_BYTES = 64 * 1024;
const MAX_ENV_ENTRIES = 256;
const MAX_ENV_VALUE_BYTES = 32 * 1024;

function fail(message: string): never {
  throw new Error(`invalid MeshAgent session runtime: ${message}`);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) fail(`${label} has unsupported fields: ${extras.join(', ')}`);
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    fail(`${label} must be an integer between 1 and ${maximum}`);
  }
  return value as number;
}

export function validateProcessLaunchPlan(value: unknown): MeshAgentProcessLaunchPlan {
  const launch = object(value, 'launch plan');
  exactKeys(launch, ['args', 'cwd', 'env'], 'launch plan');
  if (!Array.isArray(launch.args) || launch.args.length > MAX_ARGUMENT_COUNT) {
    fail(`launch args must contain at most ${MAX_ARGUMENT_COUNT} values`);
  }
  for (const argument of launch.args) {
    if (typeof argument !== 'string' || argument.includes('\0') || Buffer.byteLength(argument) > MAX_ARGUMENT_BYTES) {
      fail('launch args must be bounded strings without NUL bytes');
    }
  }
  if (typeof launch.cwd !== 'string' || !isAbsolute(launch.cwd))
    fail('launch plan requires an absolute working directory');
  if (launch.cwd.includes('\0')) fail('launch working directory cannot contain NUL bytes');
  if (launch.env !== undefined) {
    const env = object(launch.env, 'launch environment');
    if (Object.keys(env).length > MAX_ENV_ENTRIES) fail(`launch environment exceeds ${MAX_ENV_ENTRIES} entries`);
    for (const [key, entry] of Object.entries(env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) fail(`launch environment contains invalid key: ${key}`);
      if (typeof entry !== 'string' || entry.includes('\0') || Buffer.byteLength(entry) > MAX_ENV_VALUE_BYTES) {
        fail(`launch environment value for ${key} is invalid`);
      }
    }
  }
  return value as MeshAgentProcessLaunchPlan;
}

function validateStartup(value: unknown): void {
  const startup = object(value, 'startup policy');
  exactKeys(startup, ['timeoutMs'], 'startup policy');
  positiveInteger(startup.timeoutMs, 'startup timeout', MAX_STARTUP_TIMEOUT_MS);
}

function validateDriver(value: unknown, processModel: 'resident' | 'per-turn'): void {
  const result = z
    .object({
      processModel: z.enum(['resident', 'per-turn']),
      openSession: z.function(),
      accept: z.function(),
      dispose: z.function(),
      controls: z.unknown().refine(Boolean)
    })
    .passthrough()
    .safeParse(value);
  if (!result.success) fail('driver is missing required session methods');
  const candidate = result.data;
  if (candidate.processModel !== processModel) fail('driver process model does not match runtime plan');
  if (processModel === 'resident') {
    if (!z.object({ attachChannel: z.function(), sendTurn: z.function() }).safeParse(candidate).success) {
      fail('resident driver is missing required methods');
    }
  } else {
    if (!z.object({ attachTurnChannel: z.function(), completeTurn: z.function() }).safeParse(candidate).success) {
      fail('per-turn driver is missing required methods');
    }
  }
}

export function validateSessionEventRuntimeDefinition(value: unknown): SessionEventRuntimeDefinition {
  const definition = object(value, 'definition');
  exactKeys(definition, ['plan', 'driver'], 'definition');
  const plan = object(definition.plan, 'runtime plan');
  if (plan.processModel === 'resident') {
    exactKeys(plan, ['processModel', 'launch', 'channel', 'startup', 'reconnect', 'suspend'], 'resident plan');
    validateProcessLaunchPlan(plan.launch);
    validateStartup(plan.startup);
    const channel = object(plan.channel, 'channel plan');
    if (channel.kind === 'child-stdio') {
      exactKeys(channel, ['kind'], 'channel fields');
    } else if (channel.kind === 'websocket') {
      exactKeys(channel, ['kind', 'endpoint'], 'channel fields');
      if (channel.endpoint !== 'daemon-loopback') fail('websocket endpoint must be daemon-loopback');
    } else if (channel.kind === 'unix-socket') {
      exactKeys(channel, ['kind', 'endpoint'], 'channel fields');
      if (channel.endpoint !== 'daemon-runtime') fail('unix-socket endpoint must be daemon-runtime');
    } else {
      fail('channel kind is unsupported');
    }
    if (plan.reconnect !== undefined) {
      const reconnect = object(plan.reconnect, 'reconnect policy');
      exactKeys(reconnect, ['maxAttempts', 'baseDelayMs', 'maxDelayMs'], 'reconnect policy');
      positiveInteger(reconnect.maxAttempts, 'reconnect attempts', MAX_RECONNECT_ATTEMPTS);
      const baseDelayMs = positiveInteger(reconnect.baseDelayMs, 'reconnect base delay', MAX_STARTUP_TIMEOUT_MS);
      const maxDelayMs = positiveInteger(reconnect.maxDelayMs, 'reconnect maximum delay', MAX_STARTUP_TIMEOUT_MS);
      if (maxDelayMs < baseDelayMs) fail('reconnect maximum delay must not be less than its base delay');
    }
    if (plan.suspend !== undefined) {
      const suspend = object(plan.suspend, 'suspend policy');
      exactKeys(suspend, ['idleTimeoutMs'], 'suspend policy');
      positiveInteger(suspend.idleTimeoutMs, 'suspend idle timeout', MAX_IDLE_TIMEOUT_MS);
    }
    validateDriver(definition.driver, 'resident');
  } else if (plan.processModel === 'per-turn') {
    exactKeys(plan, ['processModel', 'buildTurnLaunch', 'encodeTurnInput', 'startup', 'continuation'], 'per-turn plan');
    if (typeof plan.buildTurnLaunch !== 'function' || typeof plan.encodeTurnInput !== 'function') {
      fail('per-turn plan is missing launch or input encoder');
    }
    validateStartup(plan.startup);
    const continuation = object(plan.continuation, 'continuation policy');
    exactKeys(continuation, ['strategy'], 'continuation policy');
    if (continuation.strategy !== 'provider-session-ref') fail('continuation strategy must be provider-session-ref');
    validateDriver(definition.driver, 'per-turn');
  } else {
    fail('process model must be resident or per-turn');
  }
  return value as SessionEventRuntimeDefinition;
}
