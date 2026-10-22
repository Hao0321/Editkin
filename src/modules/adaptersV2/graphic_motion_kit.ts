// Canonical adapter glue shared by the synchronous catalog and V2 loader.
import { motionGraphicKitSceneSchema, prepareMotionGraphicKitFile } from "../../mcp/motionGraphicKitTools";
import type { ModuleRuntimeAdapterV2 } from "../moduleTypes";
export const moduleRuntimeAdapterV2: ModuleRuntimeAdapterV2 = {
    inputSchema: motionGraphicKitSceneSchema,
    prepare: async ({ projectPath, inputs }) => prepareMotionGraphicKitFile(projectPath, motionGraphicKitSceneSchema.parse(inputs))
};
