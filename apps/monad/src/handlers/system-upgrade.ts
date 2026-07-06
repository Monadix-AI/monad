import type { SystemUpgradeStatus } from '@monad/protocol';

import { MONAD_VERSION } from '@monad/protocol';

export interface SystemUpgradeOptions {
  getUpgradeInfo?: () => { latestVersion: string; latestVersionCheckedAt: string } | null;
  binaryPath?: string;
  spawn?: typeof Bun.spawn;
  env?: NodeJS.ProcessEnv;
}

const STAGES: Record<SystemUpgradeStatus['stage'], number> = {
  idle: 0,
  checking: 5,
  downloading: 25,
  verifying: 50,
  installing: 75,
  restarting: 90,
  complete: 100,
  failed: 100
};

export function createSystemUpgradeModule(options: SystemUpgradeOptions = {}) {
  const spawn = options.spawn ?? Bun.spawn;
  const env = options.env ?? process.env;
  let status = buildIdleStatus(options.getUpgradeInfo);
  let running: Promise<void> | null = null;

  function current(): SystemUpgradeStatus {
    if (status.stage === 'idle') status = buildIdleStatus(options.getUpgradeInfo);
    return status;
  }

  async function start(): Promise<SystemUpgradeStatus> {
    if (running) return status;
    status = { ...buildIdleStatus(options.getUpgradeInfo), stage: 'checking', progress: STAGES.checking, error: null };
    if (!status.available) {
      status = { ...status, stage: 'complete', progress: 100 };
      return status;
    }
    running = runUpgrade().finally(() => {
      running = null;
    });
    return status;
  }

  async function runUpgrade(): Promise<void> {
    try {
      setStage('downloading');
      const proc = spawn([options.binaryPath ?? process.execPath, 'upgrade'], {
        env,
        stderr: 'pipe',
        stdout: 'pipe'
      });
      await Promise.all([consume(proc.stdout), consume(proc.stderr)]);
      const code = await proc.exited;
      if (code === 0) setStage('complete');
      else fail(`upgrade exited with code ${code}`);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }

  async function consume(stream: ReadableStream<Uint8Array> | null | undefined): Promise<void> {
    if (!stream) return;
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      observeOutput(decoder.decode(chunk, { stream: true }));
    }
  }

  function observeOutput(text: string): void {
    if (/download/i.test(text)) setStage('downloading');
    else if (/sha|verif/i.test(text)) setStage('verifying');
    else if (/install/i.test(text)) setStage('installing');
    else if (/restart|start/i.test(text)) setStage('restarting');
  }

  function setStage(stage: SystemUpgradeStatus['stage']): void {
    if (status.stage === 'failed' || status.stage === 'complete') return;
    status = { ...status, stage, progress: Math.max(status.progress, STAGES[stage]), error: null };
  }

  function fail(error: string): void {
    status = { ...status, stage: 'failed', progress: 100, error };
  }

  return { getStatus: current, start };
}

function buildIdleStatus(getUpgradeInfo?: SystemUpgradeOptions['getUpgradeInfo']): SystemUpgradeStatus {
  const latestVersion = getUpgradeInfo?.()?.latestVersion ?? null;
  return {
    available: Boolean(latestVersion && latestVersion !== MONAD_VERSION),
    currentVersion: MONAD_VERSION,
    latestVersion,
    stage: 'idle',
    progress: 0,
    error: null
  };
}
