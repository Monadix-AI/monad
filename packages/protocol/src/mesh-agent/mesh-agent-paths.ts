import { z } from 'zod';

// Accept POSIX (`/abs`) and Windows (`C:\abs`, `C:/abs`, `\\server\share`) absolute paths. This is a
// wire/browser-shared schema, so it can't import node:path — the daemon re-checks with path.isAbsolute.
const ABSOLUTE_PATH_RE = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;
export const absolutePath = (message: string) =>
  z
    .string()
    .min(1)
    .refine((value) => ABSOLUTE_PATH_RE.test(value), message);
export const absolutePathSchema = absolutePath('workingPath must be absolute');
