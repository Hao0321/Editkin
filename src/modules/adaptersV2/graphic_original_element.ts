// Canonical adapter glue shared by the synchronous catalog and V2 loader.
import { originalElementRequestSchema, prepareOriginalElementFile } from "../../mcp/motionGraphicKitTools";
import type { ModuleRuntimeAdapterV2 } from "../moduleTypes";
export const moduleRuntimeAdapterV2: ModuleRuntimeAdapterV2 = {
    inputSchema: originalElementRequestSchema,
    prepare: async ({ projectPath, variantId, inputs }) => prepareOriginalElementFile(projectPath, originalElementRequestSchema.parse({ ...inputs, elementId: variantId }))
};
