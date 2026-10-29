// Canonical adapter glue shared by the synchronous catalog and V2 loader.
import { clipMotionPresetRequestSchema, prepareClipMotionPresetFile } from "../../mcp/moduleCompilers";
import type { ModuleRuntimeAdapterV2 } from "../moduleTypes";
export const moduleRuntimeAdapterV2: ModuleRuntimeAdapterV2 = {
    inputSchema: clipMotionPresetRequestSchema,
    prepare: async ({ projectPath, variantId, inputs }) => prepareClipMotionPresetFile(clipMotionPresetRequestSchema.parse({ ...inputs, projectPath, presetId: variantId }))
};
