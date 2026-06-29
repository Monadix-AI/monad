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
  return z.url().refine(requireHttps ? isHttpsUrl : isHttpUrl, {
    message: requireHttps ? 'url must be https' : 'url must be http(s)'
  });
}

export const httpUrlSchema = createHttpUrlSchema();
