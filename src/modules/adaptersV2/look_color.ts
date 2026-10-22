// Canonical adapter glue shared by the synchronous catalog and V2 loader.
import * as z from "zod/v4";
import { findClip } from "../../domain/editGraph";
import { creativePresetCommands } from "../../mcp/moduleCompilers";
import { readProject } from "../../mcp/storage";
import { FILM_LOOKS_V2 } from "../../creative/filmLooksV2";
import type { ModuleRuntimeAdapterV2 } from "../moduleTypes";
import { clipsSchema, clipCommands } from "../moduleClipCommandsV2";
const lookSchema = z.strictObject({ clipIds: clipsSchema, strength: z.number().finite().min(0).max(1).optional() });
export const moduleRuntimeAdapterV2: ModuleRuntimeAdapterV2 = {
    inputSchema: lookSchema,
    prepare: async ({ projectPath, variantId, inputs }) => {
        const { clipIds, strength } = lookSchema.parse(inputs);
        const film = FILM_LOOKS_V2.find(look => look.id === variantId);
        if (!film) {
            if (strength !== undefined)
                throw new Error("strength 只適用 Film Look v2（film_look_v2）variants");
            return clipCommands(projectPath, clipIds, clipId => creativePresetCommands({ clipId, lookPresetId: variantId }));
        }
        const project = await readProject(projectPath);
        const legacyLooks = new Set(clipIds.filter(clipId => findClip(project, clipId).creative?.lookPresetId));
        return clipCommands(projectPath, clipIds, clipId => [
            ...(legacyLooks.has(clipId) ? [{ type: "set_clip_creative" as const, clipId, patch: { lookPresetId: null } }] : []),
            { type: "set_clip_grade_v2" as const, clipId, grade: { schema: "editkin.color-grade/v2" as const, look: { id: film.id, ...(strength !== undefined ? { strength } : {}) } } },
        ]);
    }
};
