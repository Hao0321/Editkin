import * as z from "zod/v4";

// A clip's creative state. Shared by the project schema and by saved Reference Motion instances (which record the
// primary clip's state to restore it); this module imports nothing from the project schema, so neither forms a cycle.
export const creativeTransitionSchema = z.object({ presetId: z.string(), duration: z.number() });
const nativeEffectParameterValueSchema = z.union([z.string().max(500), z.number().finite(), z.boolean()]);
export const nativeEffectInstanceSchema = z.object({
  id: z.string().min(1).max(128),
  pluginId: z.string().regex(/^[a-z][a-z0-9.-]{2,127}$/),
  capabilityId: z.string().regex(/^[a-z][a-z0-9_.-]{0,95}$/),
  pluginVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  runtimeType: z.enum(["native_effect", "gpu_effect_graph"]).optional(),
  enabled: z.boolean(),
  parameters: z.record(z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/), nativeEffectParameterValueSchema),
});
export const clipCreativeSchema = z.object({
  lookPresetId: z.string().optional(), effectPresetIds: z.array(z.string()),
  nativeEffectInstances: z.array(nativeEffectInstanceSchema).optional(),
  transitionIn: creativeTransitionSchema.optional(), transitionOut: creativeTransitionSchema.optional(),
});
