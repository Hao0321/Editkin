// Canonical adapter glue shared by the synchronous catalog and V2 loader.
import * as z from "zod/v4";
import { creativePresetCommands } from "../../mcp/moduleCompilers";
import type { ModuleRuntimeAdapterV2 } from "../moduleTypes";
import { clipsSchema, clipCommands } from "../moduleClipCommandsV2";
const transitionSchema = z.strictObject({ clipIds: clipsSchema, edge: z.enum(["in", "out", "both"]).default("in") });
export const moduleRuntimeAdapterV2: ModuleRuntimeAdapterV2 = {
    inputSchema: transitionSchema,
    prepare: async ({ projectPath, variantId, inputs }) => {
        const { clipIds, edge } = transitionSchema.parse(inputs);
        return clipCommands(projectPath, clipIds, clipId => creativePresetCommands({ clipId,
            ...(edge !== "out" ? { transitionInPresetId: variantId } : {}), ...(edge !== "in" ? { transitionOutPresetId: variantId } : {}) }));
    }
};
