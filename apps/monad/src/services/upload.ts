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

export async function readRequestBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  const contentLength = request.headers.get('content-length');
  if (contentLength) {
    const parsed = Number(contentLength);
    if (Number.isFinite(parsed) && parsed > maxBytes) throw new Error(`upload exceeds ${maxBytes} bytes`);
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let loadedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (loadedBytes + value.byteLength > maxBytes) {
        await reader.cancel();
        throw new Error(`upload exceeds ${maxBytes} bytes`);
      }
      loadedBytes += value.byteLength;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(loadedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
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
