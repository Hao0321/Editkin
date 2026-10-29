// Canonical adapter glue shared by the synchronous catalog and V2 loader.
import { referenceMotionTemplateInputSchema } from "../../motion/referenceMotionTemplates";
import { prepareReferenceMotionTemplateFile } from "../../mcp/referenceMotionTemplateTools";
import type { ModuleRuntimeAdapterV2 } from "../moduleTypes";
export const moduleRuntimeAdapterV2: ModuleRuntimeAdapterV2 = {
    inputSchema: referenceMotionTemplateInputSchema,
    prepare: async ({ projectPath, variantId, inputs, environment }) => prepareReferenceMotionTemplateFile(projectPath, referenceMotionTemplateInputSchema.parse({ ...inputs, templateId: variantId }), environment)
};
