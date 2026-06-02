// Minimal tar (ustar) reader — enough to extract files from an npm package tarball. We only
// need regular files; checksums are not verified (the bundle integrity hash is the real guard).

const BLOCK = 512;

function cstr(bytes: Uint8Array): string {
  const nul = bytes.indexOf(0);
  return new TextDecoder().decode(nul === -1 ? bytes : bytes.subarray(0, nul));
}

/** Parse an (already gunzipped) tar archive into a path→bytes map. */
export function untar(buf: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let off = 0;
  while (off + BLOCK <= buf.length) {
    const header = buf.subarray(off, off + BLOCK);
    const name = cstr(header.subarray(0, 100));
    if (name === '') break; // end-of-archive (zero block)

    const size = parseInt(cstr(header.subarray(124, 136)).trim() || '0', 8) || 0;
    const typeFlag = header[156]; // '0' (0x30) or NUL → regular file
    const prefix = cstr(header.subarray(345, 500));
    const fullName = prefix ? `${prefix}/${name}` : name;

    off += BLOCK;
    if (typeFlag === 0x30 || typeFlag === 0) {
      files.set(fullName, buf.subarray(off, off + size));
    }
    off += Math.ceil(size / BLOCK) * BLOCK;
  }
  return files;
}
