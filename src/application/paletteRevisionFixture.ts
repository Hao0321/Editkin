import { defaultMotionGraphicV2Seed } from "../motion/defaultGraphicSeedsV2";
import { createEmptyProject } from "../domain/editGraph";
import { createMotionGraphic } from "../motion/composition";
import { NATIVE_VECTOR_PRESETS } from "../creative/nativeVectorPresets";
import { listPaletteRoles, paletteRevisionHash } from "./agentPaletteRevision";
export function paletteProject() {
  const project = createEmptyProject("角色換色來源診斷", { id: "palette-diagnostic", width: 1080, height: 1920 });
  const title = createMotionGraphic("palette-title", "title", "讓能力接起來", 0, 3, undefined, defaultMotionGraphicV2Seed("title"));
  title.textColor = "#111827"; title.backgroundColor = "#FFFFFFFF";
  const seed = NATIVE_VECTOR_PRESETS.find(p => p.id === "reel_line_grid")!.seed;
  const grid = createMotionGraphic("palette-grid", "card", "", 0, 3, undefined, seed);
  // Use a genuinely different starting RGB; the peer's original example was
  // already #175CD3 on both grid roles and was a no-op under the effect guard.
  grid.textColor = "#FFFFFF30"; grid.accentColor = "#FFFFFF1C";
  project.motionGraphics.push(title, grid);
  return project;
}
export function paletteRequest(project: ReturnType<typeof paletteProject>) {
  return { expectedRevision: project.revision, expectedProjectSha256: paletteRevisionHash(project), palette: listPaletteRoles().example,
    bindings: [{ graphicId: "palette-title", colors: { textColor: "ink", backgroundColor: "background", accentColor: "primary" }, alphaMode: "retain_target" },
      { graphicId: "palette-grid", colors: { textColor: "grid", accentColor: "primary" }, alphaMode: "retain_target" }], minimumTextContrast: 4.5 };
}
