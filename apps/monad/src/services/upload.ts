import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';

export interface DecodedUpload {
  filename: string;
  bytes: Uint8Array;
  extension: string;
  text: () => string;
}

export function decodeRawUpload({ filename, bytes }: { filename: string; bytes: Uint8Array }): DecodedUpload {
  if (filename.includes('/') || filename.includes('\\') || filename.includes('\0')) {
    throw new Error('upload filename must not contain path separators');
  }

  return {
    filename,
    bytes,
    extension: extname(filename).toLowerCase(),
    text: () => new TextDecoder().decode(bytes)
  };
}

export function decodeRawUploads(uploads: Array<{ filename: string; bytes: Uint8Array }>): DecodedUpload[] {
  const filenames = new Set<string>();
  return uploads.map((upload) => {
    if (filenames.has(upload.filename)) {
      throw new Error(`duplicate upload filename: ${upload.filename}`);
    }
    filenames.add(upload.filename);
    return decodeRawUpload(upload);
  });
}

export async function unpackZipUpload(
  upload: Pick<DecodedUpload, 'bytes'>,
  { prefix = 'monad-upload-' }: { prefix?: string } = {}
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const tempDir = await mkdtemp(join(tmpdir(), prefix));
  const zipPath = join(tempDir, 'upload.zip');
  const unpackedDir = join(tempDir, 'unpacked');
  try {
    await Bun.write(zipPath, upload.bytes);
    await Bun.$`unzip -q ${zipPath} -d ${unpackedDir}`.quiet();
  } catch (err) {
    await rm(tempDir, { recursive: true, force: true });
    throw err;
  }

  return {
    dir: unpackedDir,
    cleanup: () => rm(tempDir, { recursive: true, force: true })
  };
}
