// Canonical adapter glue shared by the synchronous catalog and V2 loader.
import { compileBeatMontageInputSchema, compileBeatMontageReadOnly } from "../../mcp/montageTools";
import type { ModuleRuntimeAdapterV2 } from "../moduleTypes";
export const moduleRuntimeAdapterV2: ModuleRuntimeAdapterV2 = {
    inputSchema: compileBeatMontageInputSchema,
    prepare: async ({ projectPath, inputs }) => compileBeatMontageReadOnly(compileBeatMontageInputSchema.parse({ ...inputs, projectPath }))
};
