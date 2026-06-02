const ENV_REF_RE = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/;

/** Build an `${env:NAME}` secret reference string. */
export const envRef = (name: string) => `\${env:${name}}`;

export const matchEnvRef = (value: string) => value.match(ENV_REF_RE);
