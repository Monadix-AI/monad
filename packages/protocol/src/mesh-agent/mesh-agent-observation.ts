import { z } from 'zod';

export type {
  MeshAgentObservationEvent,
  MeshAgentObservationRole
} from './mesh-agent-observation-event.ts';

export {
  meshAgentObservationEventSchema,
  meshAgentObservationRoleSchema
} from './mesh-agent-observation-event.ts';

export const nativeAgentTurnPointerSchema = z.object({
  providerSessionRef: z.string().nullable().optional(),
  providerTurnId: z.string().nullable().optional()
});
export type NativeAgentTurnPointer = z.infer<typeof nativeAgentTurnPointerSchema>;

/** Maximum raw bytes projected into one live observation frame. The ephemeral live store is not
 *  truncated; older committed frames remain available through event pagination. */
export const MESH_AGENT_OUTPUT_SNAPSHOT_MAX = 256 * 1024;

export const managedMeshAgentLifecycleLogEventSchema = z.enum([
  'project.managed_mesh.member_start_error',
  'project.managed_mesh.resume_failed_cold_start',
  'project.managed_mesh.delivery_error',
  'project.managed_mesh.direct_delivery_error'
]);
export type ManagedMeshAgentLifecycleLogEvent = z.infer<typeof managedMeshAgentLifecycleLogEventSchema>;
