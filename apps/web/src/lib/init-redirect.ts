/**
 * Policy for whether the `/init` route should auto-redirect to home.
 *
 * `/init` is a canonical web route and stays directly reachable after setup.
 */
export function shouldRedirectInitToHome(
  _initialized: boolean,
  _isDev: boolean = process.env.NODE_ENV !== 'production'
): boolean {
  return false;
}
