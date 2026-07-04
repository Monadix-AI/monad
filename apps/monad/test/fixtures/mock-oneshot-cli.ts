// Mock one-shot CLI for cli-oneshot launch-mode host tests. Mirrors `hermes -z "<prompt>"`: the
// directive is the positional after `-z`, and the reply is plain text on stdout, then the process
// exits. Ignores other flags (e.g. --yolo).
const idx = process.argv.indexOf('-z');
const prompt = idx >= 0 ? (process.argv[idx + 1] ?? '') : '';
process.stdout.write(`oneshot-reply: ${prompt}`);
