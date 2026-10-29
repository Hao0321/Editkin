// Canonical adapter glue shared by the synchronous catalog and V2 loader.
import { nativeMotionSequenceRequestSchema, prepareNativeMotionSequenceFile } from "../../mcp/moduleCompilers";
import type { ModuleRuntimeAdapterV2 } from "../moduleTypes";
export const moduleRuntimeAdapterV2: ModuleRuntimeAdapterV2 = {
    inputSchema: nativeMotionSequenceRequestSchema,
    prepare: async ({ projectPath, inputs }) => prepareNativeMotionSequenceFile(nativeMotionSequenceRequestSchema.parse({ ...inputs, projectPath }))
};
