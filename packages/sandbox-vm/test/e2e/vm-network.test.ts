import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { realVmAdmission } from './vm-admission.ts';
import { disposeRealVm, guestArg, prepareRealVm, runSh, type VmPolicy } from './vm-fixture.ts';

// biome-ignore lint/suspicious/noUndeclaredEnvVars: explicit real-VM test gate
const ENABLED = realVmAdmission(Bun.env.MONAD_VM_IT) === 'run';

beforeAll(async () => {
  if (ENABLED) await prepareRealVm();
}, 120_000);

describe.skipIf(!ENABLED)('net:filtered egress enforcement (direct egress is dropped by nftables)', () => {
  const AGENT = 'agt_filt';
  let workspace = '';
  const policy: VmPolicy = { net: { allowProxyPort: 8888 } };

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'monad-vm-fws-'));
    policy.writableRoots = [workspace];
  });

  afterAll(async () => {
    await disposeRealVm(AGENT);
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  test('direct TCP to a non-allowlisted host is dropped', async () => {
    const result = await runSh('curl -sS --max-time 6 http://1.1.1.1 >/dev/null 2>&1; echo "RC=$?"', policy, AGENT);
    expect(result.stdout).not.toContain('RC=0');
  }, 600_000);

  test('the cloud metadata endpoint 169.254.169.254 is dropped', async () => {
    const result = await runSh(
      'curl -sS --max-time 6 http://169.254.169.254/latest/meta-data/ >/dev/null 2>&1; echo "RC=$?"',
      policy,
      AGENT
    );
    expect(result.stdout).not.toContain('RC=0');
  }, 600_000);

  test('unsetting proxy variables does not bypass egress enforcement', async () => {
    const result = await runSh(
      'unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy; curl -sS --max-time 6 http://1.1.1.1 >/dev/null 2>&1; echo "RC=$?"',
      policy,
      AGENT
    );
    expect(result.stdout).not.toContain('RC=0');
  }, 600_000);

  test('public and gvproxy DNS plus arbitrary direct TCP are dropped', async () => {
    const result = await runSh(
      'timeout 6 sh -c "echo > /dev/udp/8.8.8.8/53" 2>&1; echo "PUBLIC_DNS=$?"; ' +
        'timeout 6 sh -c "echo > /dev/udp/192.168.127.1/53" 2>&1; echo "GVPROXY_UDP_DNS=$?"; ' +
        'timeout 6 sh -c "echo > /dev/tcp/192.168.127.1/53" 2>&1; echo "GVPROXY_TCP_DNS=$?"; ' +
        'timeout 6 sh -c "echo > /dev/tcp/8.8.8.8/443" 2>&1; echo "TCP=$?"',
      policy,
      AGENT
    );
    expect(result.stdout).not.toContain('PUBLIC_DNS=0');
    expect(result.stdout).not.toContain('GVPROXY_UDP_DNS=0');
    expect(result.stdout).not.toContain('GVPROXY_TCP_DNS=0');
    expect(result.stdout).not.toContain('TCP=0');
  }, 600_000);
});

describe.skipIf(!ENABLED)('VM isolation between agents', () => {
  test("one agent's VM cannot see another agent's mounted workspace", async () => {
    const workspaceA = await mkdtemp(join(tmpdir(), 'monad-vm-a-'));
    const workspaceB = await mkdtemp(join(tmpdir(), 'monad-vm-b-'));
    await writeFile(join(workspaceB, 'b-secret'), 'AGENT_B_ONLY');
    try {
      const result = await runSh(
        `cat ${guestArg(join(workspaceB, 'b-secret'))} 2>&1; ls ${guestArg(workspaceB)} 2>&1; true`,
        { writableRoots: [workspaceA], net: 'none' },
        'agt_a'
      );
      expect(result.stdout).not.toContain('AGENT_B_ONLY');
    } finally {
      await disposeRealVm('agt_a');
      for (const directory of [workspaceA, workspaceB]) rmSync(directory, { recursive: true, force: true });
    }
  }, 600_000);
});
