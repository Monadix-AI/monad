#!/usr/bin/env bun
// msvm — the VM-sandbox runtime CLI (skeleton). A future release runs `msvm <cmd>` inside a managed
// microVM. Today it only reports that the backend is not implemented and exits non-zero, so scripts
// that adopt it fail loudly rather than silently running unconfined.

import { VmBackendNotImplementedError } from './index.ts';

function main(): never {
  const err = new VmBackendNotImplementedError();
  process.stderr.write(`${err.message}\n`);
  process.exit(69); // EX_UNAVAILABLE
}

main();
