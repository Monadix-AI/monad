import { sandboxLauncher, sandboxNetMode } from './spawn.ts';

interface ActiveLocalOsSandboxContext {
  sandboxRoots?: string[];
  backends?: { terminal?: { delegated?: boolean } };
}

/** True when a local tool call is confined by both sandbox roots and an active OS launcher. */
export function isActiveLocalOsSandbox(ctx: ActiveLocalOsSandboxContext): boolean {
  return Boolean(ctx.sandboxRoots?.length && !ctx.backends?.terminal?.delegated && sandboxLauncher().kind !== 'none');
}

function netModeIsApprovalEquivalent(): boolean {
  const launcher = sandboxLauncher();
  const enforced = launcher.enforces?.net ?? [];
  const mode = sandboxNetMode();
  const net = mode === 'none' ? 'none' : typeof mode === 'object' ? 'filtered' : 'unrestricted';
  return launcher.enforces?.readDeny === true && net !== 'unrestricted' && enforced.includes(net);
}

export function canSkipHighRiskApprovalInLocalSandbox(ctx: ActiveLocalOsSandboxContext): boolean {
  return isActiveLocalOsSandbox(ctx) && netModeIsApprovalEquivalent();
}
