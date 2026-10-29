// Canonical adapter glue shared by the synchronous catalog and V2 loader.
import * as z from "zod/v4";
import { creativePresetCommands } from "../../mcp/moduleCompilers";
import type { ModuleRuntimeAdapterV2 } from "../moduleTypes";
import { clipsSchema, clipCommands } from "../moduleClipCommandsV2";
const effectSchema = z.strictObject({ clipIds: clipsSchema, additionalEffectIds: z.array(z.string().min(1)).max(3).optional() });
export const moduleRuntimeAdapterV2: ModuleRuntimeAdapterV2 = {
    inputSchema: effectSchema,
    prepare: async ({ projectPath, variantId, inputs }) => {
        const { clipIds, additionalEffectIds } = effectSchema.parse(inputs);
        return clipCommands(projectPath, clipIds, clipId => creativePresetCommands({ clipId, effectPresetIds: [variantId ?? "", ...(additionalEffectIds ?? [])] }));
    }
};
