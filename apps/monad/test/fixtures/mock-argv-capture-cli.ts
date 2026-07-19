// Mock managed MeshAgent for `allowAutopilot` end-to-end tests: on startup it records whatever argv
// it actually received (its first positional arg is the output file, everything after that is what
// gets recorded) then stays alive like a real persistent provider process so the host treats the
// session as running.
import { writeFileSync } from 'node:fs';

const [outFile, ...recorded] = process.argv.slice(2);
if (outFile) writeFileSync(outFile, recorded.join(' '));
setInterval(() => {}, 1000);
