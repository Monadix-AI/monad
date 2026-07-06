import type { ModelCall } from '@monad/sdk-atom';
import type { Telemetry } from 'ai';
import type { AiSdkProviderSpec } from './ai-sdk-adapter.ts';

import { DevToolsTelemetry } from '@ai-sdk/devtools';
import { OpenTelemetry } from '@ai-sdk/otel';

const otelTelemetry = new OpenTelemetry({
  usage: true,
  providerMetadata: true,
  runtimeContext: true,
  enrichSpan({ runtimeContext }) {
    return {
      ...(typeof runtimeContext?.sessionId === 'string'
        ? { 'ai.telemetry.metadata.sessionId': runtimeContext.sessionId }
        : {}),
      ...(typeof runtimeContext?.userId === 'string' ? { 'ai.telemetry.metadata.userId': runtimeContext.userId } : {})
    };
  }
});

function telemetryIntegrations(): Telemetry[] {
  return Bun.env.NODE_ENV === 'development' ? [otelTelemetry, DevToolsTelemetry()] : [otelTelemetry];
}

type AiSdkRuntimeContext = {
  provider: string;
  model: string;
  sessionId?: string;
  userId?: string;
};

// Shared `telemetry` config for both the stream and complete paths — keeps the two
// call sites from drifting (a field added to one but not the other). Phoenix reads runtime context;
// sessionId/userId are promoted to OpenInference session.id/user.id by the daemon span processor.
export function buildTelemetry(
  call: ModelCall,
  spec: AiSdkProviderSpec,
  functionId: string
): {
  runtimeContext: AiSdkRuntimeContext;
  telemetry: {
    isEnabled: true;
    recordInputs: true;
    recordOutputs: true;
    functionId: string;
    includeRuntimeContext: Record<keyof AiSdkRuntimeContext, true>;
    integrations: Telemetry[];
  };
} {
  const runtimeContext: AiSdkRuntimeContext = {
    provider: spec.type,
    model: call.modelId,
    ...(call.sessionId ? { sessionId: call.sessionId } : {}),
    ...(call.userId ? { userId: call.userId } : {})
  };
  const telemetry: {
    isEnabled: true;
    recordInputs: true;
    recordOutputs: true;
    functionId: string;
    includeRuntimeContext: Record<keyof AiSdkRuntimeContext, true>;
    integrations: Telemetry[];
  } = {
    isEnabled: true,
    recordInputs: true,
    recordOutputs: true,
    functionId,
    includeRuntimeContext: {
      provider: true,
      model: true,
      sessionId: true,
      userId: true
    },
    integrations: telemetryIntegrations()
  };
  return { runtimeContext, telemetry };
}
