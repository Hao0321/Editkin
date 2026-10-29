import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve, basename } from "node:path";
import { createDemoProject } from "../domain/demo";
import { applyCommand } from "../domain/commands";
import { createMotionGraphic, legacyMotionGraphicSeed } from "../motion/composition";
import { projectVisualLayersV1 } from "../domain/unifiedLayerOrderV1";
import { parseProject } from "./projectCodec";
import { readPrimaryProjectFileWithIdentityV1, writeProjectFileAtomicWithIdentityV1 } from "./projectFiles";
import { buildEngineRenderGraph } from "../render/engineGraph";

describe("actual project file mixed-order persistence", () => {
  it("retains saved order and its executable graph through atomic save and literal reopen", async () => {
    const parent = resolve(tmpdir()), root = await mkdtemp(join(parent, "editkin-order-save-v1-"));
    try {
      const project = parseProject(createDemoProject());
      project.captions = [{ id: "caption-save", text: "Caption", start: 0, duration: 3 }];
      project.motionGraphics = [createMotionGraphic("graphic-save", "title", "Motion", 0, 3, undefined, legacyMotionGraphicSeed("title"))];
      const order = { schema: "editkin.unified-layer-order/v1" as const, layers: projectVisualLayersV1(project).map(({ kind, id }) => ({ kind, id })).reverse() };
      const ordered = applyCommand(project, { type: "set_unified_layer_order", expected: { projectId: project.id, revision: project.revision, updatedAt: project.updatedAt }, order });
      const locked = applyCommand(ordered, { type: "toggle_track_lock", trackId: "video-main" });
      const path = join(root, "ordered.editkin.json");
      const saved = await writeProjectFileAtomicWithIdentityV1(path, locked, null, { createOnly: true });
      const opened = await readPrimaryProjectFileWithIdentityV1(path);
      expect(opened.fileIdentity).toEqual(saved.fileIdentity);
      expect(opened.project.unifiedLayerOrderV1).toEqual(order);
      expect(buildEngineRenderGraph(opened.project).nodes).toEqual(buildEngineRenderGraph(saved.project).nodes);
      expect(opened.project.tracks[0].locked).toBe(true);
    } finally {
      const absolute = resolve(root);
      if (dirname(absolute) !== parent || !basename(absolute).startsWith("editkin-order-save-v1-")) throw new Error("TEST_ROOT_OWNERSHIP_MISMATCH");
      await rm(absolute, { recursive: true, force: true });
    }
  });
});
