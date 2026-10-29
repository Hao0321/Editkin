// Canonical adapter glue shared by the synchronous catalog and V2 loader.
import { motionDesignV3CreationInputSchema, prepareMotionDesignV3 } from "../../application/motionDesignV3Creation";
import { readProject } from "../../mcp/storage";
import type { ModuleRuntimeAdapterV2 } from "../moduleTypes";
export const moduleRuntimeAdapterV2: ModuleRuntimeAdapterV2 = {
    inputSchema: motionDesignV3CreationInputSchema,
    prepare: async ({ projectPath, variantId, inputs }) => prepareMotionDesignV3(await readProject(projectPath), variantId ?? "", motionDesignV3CreationInputSchema.parse(inputs))
};
