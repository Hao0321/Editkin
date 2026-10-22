// Canonical adapter glue shared by the synchronous catalog and V2 loader.
import { prepareAutopilotTemplatePackageFile, templatePackageRequestSchema } from "../../mcp/moduleCompilers";
import type { ModuleRuntimeAdapterV2 } from "../moduleTypes";
const format = "short" as const;
export const moduleRuntimeAdapterV2: ModuleRuntimeAdapterV2 = {
    inputSchema: templatePackageRequestSchema,
    prepare: async ({ projectPath, variantId, inputs }) => prepareAutopilotTemplatePackageFile(templatePackageRequestSchema.parse({ ...inputs, projectPath, format, templateId: variantId }))
};
