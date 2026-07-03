import { z } from 'zod';

export function isHttpUrl(u: string): boolean {
  try {
    return /^https?:$/.test(new URL(u).protocol);
  } catch {
    return false;
  }
}

export function isHttpsUrl(u: string): boolean {
  try {
    return new URL(u).protocol === 'https:';
  } catch {
    return false;
  }
}

export function createHttpUrlSchema({ requireHttps = false }: { requireHttps?: boolean } = {}) {
  return z
    .string()
    .trim()
    .pipe(z.url())
    .refine(requireHttps ? isHttpsUrl : isHttpUrl, {
      message: requireHttps ? 'url must be https' : 'url must be http(s)'
    });
}

export const httpUrlSchema = createHttpUrlSchema();
export const httpsUrlSchema = createHttpUrlSchema({ requireHttps: true });

export const absoluteUriSchema = z.string().trim().pipe(z.url());

export const blankableHttpUrlSchema = z
  .string()
  .trim()
  .pipe(z.union([z.literal(''), httpUrlSchema]));

export const httpOriginSchema = z
  .string()
  .trim()
  .pipe(z.url())
  .refine(
    (value) => {
      const url = new URL(value);
      return isHttpUrl(value) && url.pathname === '/' && !url.search && !url.hash;
    },
    {
      message: 'origin must be http(s) and must not include path, query, or hash'
    }
  );
