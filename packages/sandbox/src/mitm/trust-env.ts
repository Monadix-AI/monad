// Trust-anchor env vars for the CONFINED CHILD only.
//
// When the egress proxy terminates TLS with the MITM CA, the child's HTTPS clients must trust that
// CA or every request fails a cert check. These env vars point each common toolchain's CA-bundle
// override at the MITM cert path. They are injected into the sandboxed child's environment ONLY —
// never merged into the daemon/host environment, so the host trust store is untouched.

/**
 * Env vars that make a confined child trust the MITM CA at `caCertPath`. Covers Node, OpenSSL,
 * Python requests, curl, git, npm, Deno, and pip. All point at the same cert path.
 */
export function caTrustEnv(caCertPath: string): Record<string, string> {
  return {
    NODE_EXTRA_CA_CERTS: caCertPath,
    SSL_CERT_FILE: caCertPath,
    REQUESTS_CA_BUNDLE: caCertPath,
    CURL_CA_BUNDLE: caCertPath,
    GIT_SSL_CAINFO: caCertPath,
    npm_config_cafile: caCertPath,
    DENO_CERT: caCertPath,
    PIP_CERT: caCertPath
  };
}
