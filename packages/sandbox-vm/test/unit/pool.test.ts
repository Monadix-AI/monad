import { expect, test } from 'bun:test';

import { POOL_DEFAULTS, policyFingerprint, reuseKey, VmPool, vmKey } from '../../src/pool.ts';

test('reuse key is the agent under agent scope, the session otherwise', () => {
  expect(reuseKey('agent', 'ses_1', 'agt_1')).toBe('agt:agt_1');
  // No bound agent → falls back to the session even under agent scope.
  expect(reuseKey('agent', 'ses_1', undefined)).toBe('ses:ses_1');
  expect(reuseKey('session', 'ses_1', 'agt_1')).toBe('ses:ses_1');
});

test('same policy → same vmKey; differing net mode → different vmKey', () => {
  const a = vmKey('agent', 'ses_1', 'agt_1', { net: 'none' });
  const b = vmKey('agent', 'ses_2', 'agt_1', { net: 'none' }); // same agent, diff session, same policy
  const c = vmKey('agent', 'ses_1', 'agt_1', { net: 'unrestricted' }); // same agent, diff net
  expect(a).toBe(b); // reused across the agent's sessions
  expect(a).not.toBe(c); // policy shape differs → separate VM
});

test('fingerprint ignores sessionId/agentId but tracks mounts + net', () => {
  const p1 = policyFingerprint({ writableRoots: ['/a', '/b'], net: 'none', sessionId: 'x' });
  const p2 = policyFingerprint({ writableRoots: ['/b', '/a'], net: 'none', sessionId: 'y' }); // order-insensitive
  const p3 = policyFingerprint({ writableRoots: ['/a'], net: 'none' });
  expect(p1).toBe(p2);
  expect(p1).not.toBe(p3);
});

test('acquire reuses one VM across sessions; release + TTL tears it down', async () => {
  let booted = 0;
  let stopped = 0;
  const clock = 0;
  const pool = new VmPool<{ id: number }>(
    { ...POOL_DEFAULTS, idleTtlMs: 10 },
    { stop: async () => void stopped++, now: () => clock }
  );
  const key = 'agt:a#fp';
  const boot = async () => ({ id: ++booted });
  const vm1 = await pool.acquire(key, 'agt:a', 'a', boot);
  const vm2 = await pool.acquire(key, 'agt:a', 'a', boot); // second session, same agent
  expect(vm1.id).toBe(vm2.id); // one VM
  expect(booted).toBe(1);
  expect(pool.size()).toBe(1);

  pool.release(key);
  pool.release(key); // refcount → 0, idle timer armed
  await new Promise((r) => setTimeout(r, 25));
  expect(stopped).toBe(1);
  expect(pool.size()).toBe(0);
});

test('a rejected boot is NOT cached — the next acquire re-boots (no poisoned key)', async () => {
  let attempts = 0;
  const pool = new VmPool<{ id: number }>(POOL_DEFAULTS, { stop: async () => {} });
  const flakyThenOk = async () => {
    attempts++;
    if (attempts === 1) throw new Error('transient boot failure');
    return { id: attempts };
  };
  await expect(pool.acquire('k', 'agt:a', 'a', flakyThenOk)).rejects.toThrow('transient');
  // The poisoned entry must be gone, so a retry actually re-boots instead of re-throwing.
  expect(pool.size()).toBe(0);
  const vm = await pool.acquire('k', 'agt:a', 'a', flakyThenOk);
  expect(vm.id).toBe(2);
  expect(attempts).toBe(2);
});

test('disposeAgent destroys every VM for that agent (the security dispose)', async () => {
  let stopped = 0;
  const pool = new VmPool<{ id: number }>(POOL_DEFAULTS, { stop: async () => void stopped++ });
  const boot = async () => ({ id: 1 });
  await pool.acquire('agt:a#fp1', 'agt:a', 'a', boot);
  await pool.acquire('agt:a#fp2', 'agt:a', 'a', boot); // same agent, different policy shape → 2 VMs
  expect(pool.size()).toBe(2);
  await pool.disposeAgent('a');
  expect(stopped).toBe(2);
  expect(pool.size()).toBe(0);
});

test('disposeIdle preserves VMs with active processes while tearing down idle ones', async () => {
  const stopped: number[] = [];
  const pool = new VmPool<{ id: number }>(POOL_DEFAULTS, { stop: async (vm) => void stopped.push(vm.id) });
  await pool.acquire('busy', 'agt:a', 'a', async () => ({ id: 1 }));
  await pool.acquire('idle', 'agt:b', 'b', async () => ({ id: 2 }));
  pool.release('idle');

  await pool.disposeIdle();

  expect(stopped).toEqual([2]);
  expect(pool.size()).toBe(1);
});

test('at capacity with all VMs busy, a new boot is refused (never kills an active VM)', async () => {
  const pool = new VmPool<{ id: number }>({ ...POOL_DEFAULTS, maxInstances: 1 }, { stop: async () => {} });
  const boot = async () => ({ id: 1 });
  await pool.acquire('k1', 'agt:a', 'a', boot); // busy (refcount 1)
  await expect(pool.acquire('k2', 'agt:b', 'b', boot)).rejects.toThrow(/at capacity/);
});
