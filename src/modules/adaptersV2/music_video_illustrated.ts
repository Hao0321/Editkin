// Canonical adapter glue shared by the synchronous catalog and V2 loader.
import { prepareIllustratedMusicVideoInputSchema, prepareIllustratedMusicVideoReadOnly } from "../../mcp/musicVideoTools";
import type { ModuleRuntimeAdapterV2 } from "../moduleTypes";
export const moduleRuntimeAdapterV2: ModuleRuntimeAdapterV2 = {
    inputSchema: prepareIllustratedMusicVideoInputSchema,
    prepare: async ({ projectPath, inputs }) => prepareIllustratedMusicVideoReadOnly(prepareIllustratedMusicVideoInputSchema.parse({ ...inputs, projectPath }))
};
