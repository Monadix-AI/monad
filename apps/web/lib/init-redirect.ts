/**
 * Policy for whether the `/init` route should auto-redirect to home.
 *
 * Release builds bounce a completed setup back to the app — there's no reason to
 * sit on the wizard once monad is configured. Dev builds keep `/init` reachable
 * even after initialization so the wizard can be opened and iterated on directly.
 *
 * `NODE_ENV` is inlined at build time by Next.js: `next dev` → "development",
 * the static export embedded in the release binary → "production".
 */
export function shouldRedirectInitToHome(
  initialized: boolean,
  isDev: boolean = process.env.NODE_ENV !== 'production'
): boolean {
  return initialized && !isDev;
}
