// Canonical adapter glue shared by the synchronous catalog and V2 loader.
import { nativeReelSceneRequestSchema, prepareNativeReelSceneFile } from "../../mcp/moduleCompilers";
import type { ModuleRuntimeAdapterV2 } from "../moduleTypes";
export const moduleRuntimeAdapterV2: ModuleRuntimeAdapterV2 = {
    inputSchema: nativeReelSceneRequestSchema,
    prepare: async ({ projectPath, variantId, inputs }) => prepareNativeReelSceneFile(nativeReelSceneRequestSchema.parse({ ...inputs, projectPath, templateId: variantId }))
};
