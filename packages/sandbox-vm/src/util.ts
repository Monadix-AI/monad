// Shared helpers for the VM backend.

import { createServer } from 'node:net';

/** Grab a free host loopback TCP port (bind :0, read the assigned port, release). Used to give each
 *  VM a unique gvproxy ssh-forward port. Racy in principle (the port could be taken between release
 *  and gvproxy binding it), but the window is tiny and gvproxy binding failure surfaces at boot. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('freePort: could not allocate'))));
    });
  });
}

/** sha256 of a file, hashed as a STREAM so a multi-GB raw disk isn't buffered fully into memory.
 *  One implementation, imported by both the toolchain (binary pins) and image (base-disk) verifiers,
 *  so the security-critical checksum primitive can't drift between two copies. */
export async function sha256OfFile(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  const stream = Bun.file(path).stream();
  for await (const chunk of stream) hasher.update(chunk);
  return hasher.digest('hex');
}
