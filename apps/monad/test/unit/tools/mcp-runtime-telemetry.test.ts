import { expect, test } from 'bun:test';

import {
  mcpRuntimeTelemetrySnapshot,
  recordMcpAppRefresh,
  recordMcpUrlElicitation
} from '#/capabilities/tools/registry/mcp/runtime-telemetry.ts';

test('MCP runtime telemetry records refresh and URL elicitation outcomes', () => {
  const before = mcpRuntimeTelemetrySnapshot();

  recordMcpAppRefresh('succeeded', 12);
  recordMcpUrlElicitation('accepted');

  const after = mcpRuntimeTelemetrySnapshot();
  expect({
    acceptedDelta: after.elicitationOutcomes.accepted - before.elicitationOutcomes.accepted,
    maxDurationAtLeastSample: after.refreshDurationMaxMs >= 12,
    succeededDelta: after.refreshOutcomes.succeeded - before.refreshOutcomes.succeeded
  }).toEqual({ acceptedDelta: 1, maxDurationAtLeastSample: true, succeededDelta: 1 });
});
