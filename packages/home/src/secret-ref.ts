const ENV_REF_RE = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/;
const SECRET_REF_RE = /^\$\{secret:([^}]+)\}$/;

/** Build an `${env:NAME}` secret reference string. */
export const envRef = (name: string) => `\${env:${name}}`;

/** Build a `${secret:NAME}` named-secret reference string. */
export const secretRef = (name: string) => `\${secret:${name}}`;

export const matchEnvRef = (value: string) => value.match(ENV_REF_RE);

/** Returns the secret name when `value` is a `${secret:NAME}` reference, else null. */
export const matchSecretRef = (value: string) => value.match(SECRET_REF_RE);
