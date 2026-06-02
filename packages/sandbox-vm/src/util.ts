// Shared helpers for the VM backend.

/** sha256 of a file, hashed as a STREAM so a multi-GB raw disk isn't buffered fully into memory.
 *  One implementation, imported by both the toolchain (binary pins) and image (base-disk) verifiers,
 *  so the security-critical checksum primitive can't drift between two copies. */
export async function sha256OfFile(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  const stream = Bun.file(path).stream();
  for await (const chunk of stream) hasher.update(chunk);
  return hasher.digest('hex');
}
