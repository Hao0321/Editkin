// Canonical adapter glue shared by the synchronous catalog and V2 loader.
import { motionGraphicCreationInputSchema } from "../../application/motionGraphicCreation";
import { prepareMotionGraphicCreationFile } from "../../mcp/motionGraphicCreationFile";
import { creatableMotionPresets } from "../moduleMotionPresetSourceV2";
import type { ModuleRuntimeAdapterV2 } from "../moduleTypes";
const presets = creatableMotionPresets();
const presetKind = (id: string) => presets.find(preset => preset.id === id)?.seed.kind;
export const moduleRuntimeAdapterV2: ModuleRuntimeAdapterV2 = {
    inputSchema: motionGraphicCreationInputSchema,
    prepare: async ({ projectPath, variantId, inputs, environment, signal }) => prepareMotionGraphicCreationFile(projectPath, motionGraphicCreationInputSchema.parse({ kind: presetKind(variantId ?? ""), ...inputs, presetId: variantId }), environment, signal)
};
