// Canonical adapter glue shared by the synchronous catalog and V2 loader.
import * as z from "zod/v4";
import { creativePresetCommands } from "../../mcp/moduleCompilers";
import { readProject } from "../../mcp/storage";
import type { ModuleRuntimeAdapterV2 } from "../moduleTypes";
const textStyleSchema = z.strictObject({});
export const moduleRuntimeAdapterV2: ModuleRuntimeAdapterV2 = {
    inputSchema: textStyleSchema,
    prepare: async ({ projectPath, variantId, inputs }) => {
        textStyleSchema.parse(inputs);
        const project = await readProject(projectPath);
        return { status: "PREPARED", projectRevision: project.revision, commands: creativePresetCommands({ textStylePresetId: variantId }) };
    }
};
