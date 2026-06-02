import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Generates a real, spawnable mock provider CLI (same claude-code-style JSONL wire shape as the
 * hand-inlined script in mesh-agent-runtime.test.ts) whose failure behavior is controllable by
 * the test, instead of always exiting cleanly. This exercises the real Bun.spawn/PID-tracking/
 * orphan-reconcile path — no abstract "fake launcher" interface is injected into MeshAgentHost,
 * since the provider boundary here is already a subprocess by design.
 */
export interface ControllableMeshAgentCliOptions {
  /** Written as `session_id` on every emitted frame; the daemon persists this as providerSessionRef. */
  sessionRef: string;
  /** Process exit code once the turn completes. 0 = clean exit (default). Ignored if hangAfterInit
   *  or exitAfterInit is set. */
  exitCode?: number;
  /** When true, the script emits only the init line, then blocks forever reading stdin without
   *  ever emitting a result — simulating a turn that dies mid-flight and must be reaped by an
   *  external signal (the caller kills it by pid). The daemon observes this as a signalled exit,
   *  not a provider-reported exit code. */
  hangAfterInit?: boolean;
  /** When set, the script emits only the init line, then exits immediately with this code — no
   *  assistant/result frame. Simulates the provider process itself crashing mid-turn (an exit
   *  code the daemon must reconcile), distinct from hangAfterInit's externally-signalled death. */
  exitAfterInit?: number;
}

export async function writeControllableMeshAgentCli(
  dir: string,
  options: ControllableMeshAgentCliOptions
): Promise<string> {
  const script = join(dir, `controllable-mesh-agent-cli-${options.sessionRef}.js`);
  const exitCode = options.exitCode ?? 0;
  const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: options.sessionRef, cwd: '.' });
  const authGate =
    'if (args === "auth status --json") { process.stdout.write(JSON.stringify({ state: "authenticated" }) + "\\n"); process.exit(0); }';
  const body =
    options.hangAfterInit || options.exitAfterInit !== undefined
      ? [
          '#!/usr/bin/env bun',
          'const args = process.argv.slice(2).join(" ");',
          authGate,
          `process.stdout.write(${JSON.stringify(init)} + "\\n");`,
          options.hangAfterInit
            ? // Never resolve: the turn is left "in flight" until the test sends a signal to this pid.
              'await new Promise(() => {});'
            : `process.exit(${options.exitAfterInit});`
        ].join('\n')
      : [
          '#!/usr/bin/env bun',
          'const args = process.argv.slice(2).join(" ");',
          authGate,
          'let input = "";',
          'process.stdin.on("data", (chunk) => {',
          '  input += chunk.toString();',
          '  const boundary = input.indexOf("\\n");',
          '  if (boundary < 0) return;',
          '  const line = input.slice(0, boundary);',
          `  process.stdout.write(${JSON.stringify(init)} + "\\n");`,
          `  process.stdout.write(JSON.stringify({ type: "assistant", session_id: ${JSON.stringify(options.sessionRef)}, message: { role: "assistant", content: [{ type: "text", text: "echo:" + line }] } }) + "\\n");`,
          `  process.stdout.write(JSON.stringify({ type: "result", subtype: ${exitCode === 0 ? '"success"' : '"error"'}, result: "", permission_denials: [] }) + "\\n");`,
          `  process.exit(${exitCode});`,
          '});'
        ].join('\n');
  await writeFile(script, body);
  await chmod(script, 0o755);
  return script;
}
