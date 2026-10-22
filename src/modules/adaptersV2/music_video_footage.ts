// Canonical adapter glue shared by the synchronous catalog and V2 loader.
import { prepareMusicVideoDraftInputSchema, prepareMusicVideoDraftReadOnly } from "../../mcp/musicVideoTools";
import type { ModuleRuntimeAdapterV2 } from "../moduleTypes";
export const moduleRuntimeAdapterV2: ModuleRuntimeAdapterV2 = {
    inputSchema: prepareMusicVideoDraftInputSchema,
    prepare: async ({ projectPath, inputs }) => prepareMusicVideoDraftReadOnly(prepareMusicVideoDraftInputSchema.parse({ ...inputs, projectPath }))
};
