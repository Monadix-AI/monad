// Real-VM confinement conformance — adversarial, modeled on @anthropic-ai/sandbox-runtime's attack
// tests. Boots an actual Fedora CoreOS VM (vfkit, QEMU/KVM, or Hyper-V) and tries to ESCAPE it, then
// asserts with a HOST-SIDE oracle (never trusts the guest's own error): the escape target on the host
// is untouched, egress never reaches the network. Gated: MONAD_VM_IT=1 + the base image present.
//
// This is the launcher's ADMISSION GATE (docs/proposals/sandbox-package-extraction.md §4): a backend
// that can't prove these does not ship.
//
// Boots are expensive (seconds on vfkit/KVM, minutes on QEMU/TCG), so each describe block boots ONE VM
// (a distinct agent per net mode / isolation peer) and reuses it across every attack.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { realVmAdmission } from './vm-admission.ts';
import {
  disposeRealVm,
  drainBytes as drain,
  guestArg,
  type VmPolicy as Policy,
  prepareRealVm,
  runSh as sh,
  spawnVm as spawn,
  waitForGuestProcess,
  waitForHostFile
} from './vm-fixture.ts';

// biome-ignore lint/suspicious/noUndeclaredEnvVars: test-only gate for the heavy real-VM run
const ENABLED = realVmAdmission(Bun.env.MONAD_VM_IT) === 'run';

let prepared = false;
beforeAll(async () => {
  if (!ENABLED) return;
  await prepareRealVm();
  prepared = true;
}, 120_000);

describe.skipIf(!ENABLED)('net:none confinement (fs escape, credential, privilege)', () => {
  const AGENT = 'agt_none';
  let ws: string; // writable mount
  let ro: string; // readonly mount
  let hostSecretOutside: string; // a host file NOT mounted — the escape oracle
  let deniedDir: string;
  let maskedCredential: string;
  const NET: Policy = {} as Policy;

  beforeAll(async () => {
    if (!prepared) return;
    ws = await mkdtemp(join(tmpdir(), 'monad-vm-ws-'));
    ro = await mkdtemp(join(tmpdir(), 'monad-vm-ro-'));
    hostSecretOutside = join(mkdtempSync(join(tmpdir(), 'monad-vm-secret-')), 'host-secret');
    writeFileSync(hostSecretOutside, 'HOST_SECRET_NEVER_REACHABLE');
    deniedDir = join(ws, '.ssh');
    maskedCredential = join(ws, '.credentials');
    const fakeStore = join(ws, '.monad-mask-store');
    await Promise.all([mkdir(deniedDir, { recursive: true }), mkdir(fakeStore, { recursive: true })]);
    await writeFile(join(deniedDir, 'id_ed25519'), 'PRIVATE_KEY_NEVER_REACHABLE');
    await writeFile(maskedCredential, 'REAL_CREDENTIAL_NEVER_REACHABLE');
    const fakeCredential = join(fakeStore, 'empty');
    await writeFile(fakeCredential, 'MASKED');
    Object.assign(NET, {
      writableRoots: [ws],
      readableRoots: [ro],
      readDenyRoots: [deniedDir],
      maskedFiles: [{ real: maskedCredential, fake: fakeCredential }],
      net: 'none'
    });
  }, 30_000);

  afterAll(async () => {
    await disposeRealVm(AGENT);
    for (const d of [ws, ro]) if (d) rmSync(d, { recursive: true, force: true });
  }, 60_000);

  test('boots and runs a command as the unprivileged host user without sudo', async () => {
    const r = await sh('echo OK; id -u; whoami; sudo -n true 2>&1 || echo NOSUDO', NET, AGENT);
    const lines = r.stdout.trim().split('\n');
    expect(lines[0]).toBe('OK');
    expect(lines[1]).toBe(String(process.getuid?.() ?? 1001));
    expect(lines[1]).not.toBe('0');
    expect(lines[2]).toBe('monad');
    expect(lines.at(-1)).toBe('NOSUDO');
  }, 600_000);

  test('interactive runs have a real PTY with resize and merged output', async () => {
    const proc = spawn(
      ['sh', '-c', "stty -echo; read line; stty size; printf 'LINE=%s\\n' \"$line\"; printf 'STDERR-MERGED\\n' >&2"],
      NET,
      AGENT,
      { terminal: { cols: 90, rows: 31 } }
    );
    const stdout = drain(proc.stdout);

    expect(proc.stderr).toBeUndefined();
    await proc.terminal?.resize(132, 44);
    await proc.terminal?.write('hello-pty\n');

    expect(await proc.exited).toBe(0);
    expect(await stdout).toContain('44 132');
    expect(await stdout).toContain('LINE=hello-pty');
    expect(await stdout).toContain('STDERR-MERGED');
  }, 600_000);

  test('guest overlays hide denied paths and replace masked files', async () => {
    const r = await sh(
      `cat ${guestArg(join(deniedDir, 'id_ed25519'))} 2>/dev/null || echo DENIED; ` +
        `printf 'MASK='; cat ${guestArg(maskedCredential)}`,
      NET,
      AGENT
    );

    expect(r.stdout).toContain('DENIED');
    expect(r.stdout).toContain('MASK=MASKED');
    expect(r.stdout).not.toContain('PRIVATE_KEY_NEVER_REACHABLE');
    expect(r.stdout).not.toContain('REAL_CREDENTIAL_NEVER_REACHABLE');
  }, 600_000);

  test('write OUTSIDE any mount stays in the guest namespace — the host escape target is untouched', async () => {
    await sh(
      `echo pwned > ${guestArg(hostSecretOutside)} 2>/dev/null; echo x > /etc/monad-escape 2>/dev/null; true`,
      NET,
      AGENT
    );
    expect(existsSync('/etc/monad-escape')).toBe(false); // the test host's /etc
    expect(await Bun.file(hostSecretOutside).text()).toBe('HOST_SECRET_NEVER_REACHABLE');
  }, 600_000);

  test('symlink escape: a link in the writable mount → host path does NOT grant host write', async () => {
    // srt's highest-value port: symlink inside an allowed dir pointing outside, then write through it.
    // In a VM the link resolves in the guest namespace, so the host target is never reached.
    await sh(
      `ln -sf ${guestArg(hostSecretOutside)} ${guestArg(join(ws, 'escape-link'))}; ` +
        `echo pwned > ${guestArg(join(ws, 'escape-link'))} 2>/dev/null; ` +
        `ln -sf /etc ${guestArg(join(ws, 'etc-link'))}; ` +
        `echo pwned > ${guestArg(join(ws, 'etc-link', 'monad-escape2'))} 2>/dev/null; true`,
      NET,
      AGENT
    );
    expect(await Bun.file(hostSecretOutside).text()).toBe('HOST_SECRET_NEVER_REACHABLE');
    expect(existsSync('/etc/monad-escape2')).toBe(false);
  }, 600_000);

  test('write to a READONLY mount fails (ro virtio-fs), directly and via a symlink into it', async () => {
    const r = await sh(
      `echo direct > ${guestArg(join(ro, 'ro-write'))} 2>&1; echo "RC=$?"; ` +
        `ln -sf ${guestArg(ro)} ${guestArg(join(ws, 'ro-link'))}; ` +
        `echo viaLink > ${guestArg(join(ws, 'ro-link', 'x'))} 2>&1; echo "RC2=$?"`,
      NET,
      AGENT
    );
    expect(r.stdout).not.toContain('RC=0');
    expect(r.stdout).not.toContain('RC2=0');
    expect(existsSync(join(ro, 'ro-write'))).toBe(false);
    expect(existsSync(join(ro, 'x'))).toBe(false);
  }, 600_000);

  test('a path NOT mounted (host credential file) is absent in the guest', async () => {
    const r = await sh(
      `cat ${guestArg(hostSecretOutside)} 2>&1; ls -la ${guestArg(hostSecretOutside)} 2>&1; true`,
      NET,
      AGENT
    );
    expect(r.stdout).not.toContain('HOST_SECRET_NEVER_REACHABLE');
  }, 600_000);

  test('the unprivileged workload cannot alter the guest firewall or bring up an interface', async () => {
    const r = await sh(
      'nft flush ruleset 2>&1; echo "NFT=$?"; ip link add dummy0 type dummy 2>&1; echo "IP=$?"; ' +
        'ip link set lo down 2>&1; echo "LO=$?"',
      NET,
      AGENT
    );
    expect(r.stdout).not.toContain('NFT=0'); // needs root
    expect(r.stdout).not.toContain('IP=0');
    expect(r.stdout).not.toContain('LO=0');
  }, 600_000);

  test('net:none → NO network device at all, so every egress attempt (incl. metadata) fails', async () => {
    const r = await sh(
      'ip -o link | grep -v " lo:" | wc -l; ' +
        'curl -sS --max-time 5 http://1.1.1.1 >/dev/null 2>&1; echo "EXT=$?"; ' +
        'curl -sS --max-time 5 http://169.254.169.254/ >/dev/null 2>&1; echo "META=$?"',
      NET,
      AGENT
    );
    expect(r.stdout.split('\n')[0]?.trim()).toBe('0'); // zero non-loopback NICs
    expect(r.stdout).not.toContain('EXT=0');
    expect(r.stdout).not.toContain('META=0');
  }, 600_000);

  test('cancellation terminates the workload and its descendants before they can mutate the host mount', async () => {
    const ready = join(ws, 'cancel-ready');
    const survived = join(ws, 'descendant-survived');
    const proc = spawn(
      ['sh', '-c', `touch ${guestArg(ready)}; (sleep 2; echo survived > ${guestArg(survived)}) & wait`],
      NET,
      AGENT,
      { limits: { terminateGraceMs: 500 } }
    );
    const output = Promise.all([drain(proc.stdout), drain(proc.stderr)]);
    await waitForGuestProcess(proc);
    await waitForHostFile(ready);

    proc.kill('SIGTERM');

    expect(await proc.exit).toEqual({ code: null, signal: 15 });
    await output;
    await Bun.sleep(2500);
    expect(existsSync(survived)).toBe(false);
  }, 600_000);

  test('PTY cancellation terminates descendants before they can mutate the host mount', async () => {
    const ready = join(ws, 'pty-cancel-ready');
    const survived = join(ws, 'pty-descendant-survived');
    const proc = spawn(
      [
        'sh',
        '-c',
        `stty -echo; touch ${guestArg(ready)}; ` + `(sleep 2; echo survived > ${guestArg(survived)}) & read line; wait`
      ],
      NET,
      AGENT,
      { limits: { terminateGraceMs: 500 }, terminal: { cols: 80, rows: 24 } }
    );
    const output = drain(proc.stdout);
    await waitForGuestProcess(proc);
    try {
      await waitForHostFile(ready);
    } catch (error) {
      proc.kill('SIGKILL');
      const [exit, transcript] = await Promise.all([proc.exit, output]);
      throw new Error(`${String(error)}; exit=${JSON.stringify(exit)}; output=${JSON.stringify(transcript)}`);
    }

    proc.kill('SIGTERM');

    expect(await proc.exit).toEqual({ code: null, signal: 15 });
    await output;
    await Bun.sleep(2500);
    expect(existsSync(survived)).toBe(false);
  }, 600_000);

  test('overlapping writable parent and readable child do not re-expose deny or mask targets', async () => {
    const child = join(ws, 'overlap-child');
    const denied = join(child, '.ssh');
    const real = join(child, '.credentials');
    const fakeStore = join(ws, '.overlap-mask-store');
    const fake = join(fakeStore, 'empty');
    await Promise.all([mkdir(denied, { recursive: true }), mkdir(fakeStore, { recursive: true })]);
    await Promise.all([
      writeFile(join(denied, 'id_ed25519'), 'OVERLAP_PRIVATE_KEY'),
      writeFile(real, 'OVERLAP_REAL_CREDENTIAL'),
      writeFile(fake, 'OVERLAP_MASKED')
    ]);
    const policy: Policy = {
      writableRoots: [ws],
      readableRoots: [child],
      readDenyRoots: [denied],
      maskedFiles: [{ real, fake }],
      net: 'none'
    };

    const result = await sh(
      `cat ${guestArg(join(denied, 'id_ed25519'))} 2>/dev/null || echo DENIED; ` +
        `printf 'MASK='; cat ${guestArg(real)}`,
      policy,
      AGENT
    );

    expect(result.stdout).toContain('DENIED');
    expect(result.stdout).toContain('MASK=OVERLAP_MASKED');
    expect(result.stdout).not.toContain('OVERLAP_PRIVATE_KEY');
    expect(result.stdout).not.toContain('OVERLAP_REAL_CREDENTIAL');
  }, 600_000);

  test('concurrent runs in one reused VM cannot observe each other process state or private tmpfs', async () => {
    const ready = join(ws, 'concurrent-ready');
    const release = join(ws, 'concurrent-release');
    const runA = spawn(
      [
        'sh',
        '-c',
        `echo RUN_A_ONLY >/tmp/concurrent-secret; touch ${guestArg(ready)}; ` +
          `while [ ! -e ${guestArg(release)} ]; do sleep 0.05; done`
      ],
      NET,
      AGENT
    );
    const runAOutput = Promise.all([drain(runA.stdout), drain(runA.stderr)]);
    try {
      await waitForGuestProcess(runA);
      await waitForHostFile(ready);
      const runB = await sh(
        `test ! -e /tmp/concurrent-secret; echo "TMP=$?"; ` +
          `for p in /proc/[0-9]*/cmdline; do tr '\\0' ' ' <"$p" 2>/dev/null; done`,
        NET,
        AGENT
      );

      expect(runB.stdout).toContain('TMP=0');
      expect(runB.stdout).not.toContain('RUN_A_ONLY');
    } finally {
      await writeFile(release, 'release');
      await runA.exited;
      await runAOutput;
    }
  }, 600_000);

  test('each run has a bounded private PID view and private tmpfs', async () => {
    const firstPid = await sh('echo $$; echo secret >/tmp/only-first-run', NET, AGENT);
    const second = await sh('echo $$; test ! -e /tmp/only-first-run; echo "TMP=$?"', NET, AGENT);

    const first = Number.parseInt(firstPid.stdout.trim(), 10);
    const next = Number.parseInt(second.stdout.split('\n')[0] ?? '', 10);
    expect(first).toBeGreaterThan(1);
    expect(first).toBeLessThan(32);
    expect(next).toBeGreaterThan(1);
    expect(next).toBeLessThan(32);
    expect(second.stdout).toContain('TMP=0');
  }, 600_000);

  test('per-run pids cgroup applies the requested process ceiling', async () => {
    const proc = spawn(
      ['sh', '-c', `cg=$(awk -F: '$1 == "0" { print $3 }' /proc/self/cgroup); cat /sys/fs/cgroup"$cg"/pids.max`],
      NET,
      AGENT,
      { limits: { maxProcesses: 32 } }
    );

    expect((await drain(proc.stdout)).trim()).toBe('32');
    expect(await proc.exited).toBe(0);
  }, 600_000);

  test('a containment-relevant policy change boots a VM with the new mount identity', async () => {
    const alternate = await mkdtemp(join(tmpdir(), 'monad-vm-policy-'));
    try {
      const target = join(alternate, 'new-policy-visible');
      const result = await sh(
        `echo visible > ${guestArg(target)}`,
        { writableRoots: [alternate], net: 'none' } as Policy,
        AGENT
      );
      expect(result).toEqual({ code: 0, stdout: '' });
      expect(await Bun.file(target).text()).toBe('visible\n');
    } finally {
      rmSync(alternate, { recursive: true, force: true });
    }
  }, 600_000);
});
