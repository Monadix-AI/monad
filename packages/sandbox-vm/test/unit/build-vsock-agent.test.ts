import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('guest agent build tests first and replaces binaries only after both builds succeed', async () => {
  const script = await Bun.file(join(import.meta.dir, '../../native/vsock-agent/build.sh')).text();
  const testAt = script.indexOf('go test ./...');
  const armBuildAt = script.indexOf('GOARCH=arm64');
  const amdBuildAt = script.indexOf('GOARCH=amd64');
  const firstMoveAt = script.indexOf('mv "$TMP/vsock-agent-arm64"');

  expect(testAt).toBeGreaterThan(-1);
  expect(armBuildAt).toBeGreaterThan(testAt);
  expect(amdBuildAt).toBeGreaterThan(armBuildAt);
  expect(firstMoveAt).toBeGreaterThan(amdBuildAt);
  expect(script).toContain('trap cleanup EXIT');
});
