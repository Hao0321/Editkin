// Canonical adapter glue shared by the synchronous catalog and V2 loader.
import { floatingFrameSceneRequestSchema, prepareFloatingFrameSceneFile } from "../../mcp/moduleCompilers";
import type { ModuleRuntimeAdapterV2 } from "../moduleTypes";
export const moduleRuntimeAdapterV2: ModuleRuntimeAdapterV2 = {
    inputSchema: floatingFrameSceneRequestSchema,
    prepare: async ({ projectPath, variantId, inputs }) => prepareFloatingFrameSceneFile(floatingFrameSceneRequestSchema.parse({ ...inputs, projectPath, presetId: variantId }))
};
