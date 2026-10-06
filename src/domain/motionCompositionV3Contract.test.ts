import { describe, expect, it } from "vitest";
import { MOTION_DESIGN_V3_PRESETS } from "../creative/motionDesignV3Presets";
import { applyCommand } from "./commands";
import { createEmptyProject, migrateProject, validateProject } from "./editGraph";
import { assertMotionGraphicV3Contract, MOTION_DESIGN_V3_FIELDS, motionV3Lines } from "./motionCompositionV3Contract";
import { editorCommandSchema, projectSchema } from "./schema";
import type { MotionGraphic } from "./types";

function v3Graphic(overrides: Partial<MotionGraphic> = {}): MotionGraphic {
  const preset = MOTION_DESIGN_V3_PRESETS.find(item => item.id === "v3_lower_third_bar")!;
  return { ...preset.seed, id: "v3-name", timelineStart: 0, duration: 3, ...overrides } as MotionGraphic;
}

const base = () => createEmptyProject("v3 contract", { id: "v3-contract" });
const add = (graphic: MotionGraphic) => applyCommand(base(), { type: "add_motion_graphic", graphic });

describe("Motion Design v3 contract", () => {
  it("accepts every shipped preset through the agent-visible command schema", () => {
    for (const preset of MOTION_DESIGN_V3_PRESETS) {
      const graphic = { ...preset.seed, id: preset.id, timelineStart: 0, duration: 3 } as MotionGraphic;
      expect(editorCommandSchema.safeParse({ type: "add_motion_graphic", graphic }).success, preset.id).toBe(true);
      const project = add(graphic);
      expect(project.motionGraphics[0].designV3?.template).toBe(preset.seed.designV3?.template);
      expect(projectSchema.safeParse(project).success, preset.id).toBe(true);
    }
  });

  it("reads one field per line and ignores trailing blank lines", () => {
    expect(motionV3Lines("王小明\r\n 攝影師 \n\n")).toEqual(["王小明", "攝影師"]);
    expect(MOTION_DESIGN_V3_FIELDS.compare_split).toHaveLength(4);
  });

  it.each([
    ["designV3 missing", { designV3: undefined }, /designV3|版型/u],
    ["v2 motion on v3", { motionV2: { sequence: { unit: "all", order: "forward", exitOrder: "forward", staggerFrames: 0 }, entrance: { durationFrames: 8, offsetXPixels: 0, offsetYPixels: 0, scale: 1, opacity: 0, easing: { type: "linear" } }, exit: { durationFrames: 8, offsetXPixels: 0, offsetYPixels: 0, scale: 1, opacity: 0, easing: { type: "linear" } } } }, /v2/u],
    ["legacy material", { visualStyle: "holo_scan_cyan" }, /visualStyle/u],
    ["too many lines", { text: "一\n二\n三" }, /1–2 行/u],
    ["blank required field", { text: "\n攝影師" }, /不可空白|1–2 行/u],
    ["overlong line", { text: "字".repeat(65) }, /超過 64 字/u],
    ["shorter than a full entrance and exit", { duration: .5 }, /至少需要 1 秒/u],
  ] as Array<[string, Partial<MotionGraphic>, RegExp]>)("rejects %s", (_name, overrides, message) => {
    expect(() => add(v3Graphic(overrides))).toThrow(message);
  });

  it("does not bind templates to tracking anchors yet", () => {
    // Dangling track ids are normalised away before validation, so check the contract itself.
    expect(() => assertMotionGraphicV3Contract(v3Graphic({ trackId: "track-1", trackingMode: "anchor" }))).toThrow(/追蹤/u);
  });

  it("refuses designV3 on an older schema", () => {
    expect(() => add(v3Graphic({ schema: "hao.motion-composition/v2" }))).toThrow();
  });

  it("validates edits against the template, failing closed", () => {
    const project = add(v3Graphic());
    const renamed = applyCommand(project, { type: "update_motion_graphic", graphicId: "v3-name", patch: { text: "陳怡君\n咖啡烘豆師" } });
    expect(renamed.motionGraphics[0].text).toBe("陳怡君\n咖啡烘豆師");
    expect(() => applyCommand(project, { type: "update_motion_graphic", graphicId: "v3-name", patch: { text: "一\n二\n三" } })).toThrow();
    const switched = applyCommand(project, { type: "update_motion_graphic", graphicId: "v3-name", patch: { designV3: { template: "tag_pill" }, text: "開箱實測" } });
    expect(switched.motionGraphics[0].designV3).toEqual({ template: "tag_pill" });
  });

  it("opens schema 8 projects unchanged apart from the version", () => {
    const legacy = structuredClone(base()) as unknown as Record<string, unknown>;
    legacy.schemaVersion = 8;
    const migrated = validateProject(migrateProject(legacy));
    expect(migrated.schemaVersion).toBe(9);
    expect({ ...migrated, schemaVersion: 8, updatedAt: legacy.updatedAt }).toEqual(legacy);
  });
});
