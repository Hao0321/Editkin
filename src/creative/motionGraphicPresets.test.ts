import { describe, expect, it } from "vitest";
import { applyCommand } from "../domain/commands";
import { createDemoProject } from "../domain/demo";
import { createEmptyProject } from "../domain/editGraph";
import { editorCommandSchema, projectSchema } from "../domain/schema";
import { createMotionGraphic } from "../motion/composition";
import { assertMotionGraphicPresetBinding, compactMotionGraphicPresets, findMotionGraphicPreset, motionGraphicPresets } from "./motionGraphicPresets";
import { MOTION_DESIGN_V3_FIELDS } from "../domain/motionCompositionV3Contract";

// These four original editorial candidates predate the commercial asset pack.
// Their existence/instantiation does not imply visual or human art approval.
const TRAVEL_EDITORIAL_IDS = [
  "travel_editorial_hero", "travel_editorial_eyebrow",
  "travel_editorial_hero_dark", "travel_editorial_eyebrow_dark",
] as const;
const EXPECTED_PRESET_IDS = [
  "surface-track", "v2-word-cascade", ...TRAVEL_EDITORIAL_IDS,
  "lower_third_clean_blue_name", "lower_third_clean_blue_unit",
  "lower_third_documentary_white_name", "lower_third_documentary_white_unit",
  "lower_third_signal_lime_name", "lower_third_signal_lime_unit",
  "holo_prism_scan", "holo_surface_grid", "holo_target_lock", "holo_spectral_wire",
  "holo_depth_glass", "holo_telemetry_beam", "holo_neon_extrude", "holo_quantum_label",
  "studio_marker_burst", "studio_comic_impact", "studio_neon_edge", "studio_editorial_serif",
  "studio_soft_sticker", "studio_ink_brush", "studio_sport_score", "studio_proof_stamp",
  "exp26w2_source_required", "exp26w2_real_footage", "exp26w2_screen_recording",
  "exp26w2_speaker_one", "exp26w2_speaker_two", "exp26w2_key_takeaway", "exp26w2_limitation",
  "exp26w2_before_state", "exp26w2_after_state", "exp26w2_chapter_progress",
  "exp26w2_saved_item", "exp26w2_ready_to_try", "exp26w2_hero_metric",
  "exp26w2_progress_meter", "exp26w2_line_trend", "exp26w2_donut_share",
  "exp26w2_before_after_bar", "exp26w2_ranking_stack", "exp26w2_checklist_three",
  "exp26w2_audio_wave", "exp26w2_story_timeline", "exp26w2_activity_heatmap",
  "exp26w2_step_ladder", "exp26w2_score_gauge", "exp26w2_stacked_share",
  "exp26w2_split_result", "exp26w2_kpi_row", "exp26w2_source_card",
  "exp26w2_speaker_activity", "exp26w2_retention_curve", "exp26w2_cinematic_alert_depth",
  "exp26w2_tactile_system_notes", "exp26w2_structured_signal", "exp26w2_iridescent_object_stage",
  "exp26w2_local_editorial_calm", "exp26w2_surreal_signal_play",
] as const;

// Motion Design v3 presets lead the registry; their multi-field copy is covered by motionCompositionV3Contract.test.ts.
const V3_PRESET_IDS = [
  "v3_title_reveal",
  "v3_title_reveal_panel",
  "v3_title_reveal_paper",
  "v3_title_impact",
  "v3_title_impact_signal",
  "v3_title_editorial",
  "v3_lower_third_bar",
  "v3_lower_third_paper",
  "v3_lower_third_clean",
  "v3_lower_third_glass",
  "v3_chapter_number",
  "v3_chapter_card",
  "v3_stat_counter",
  "v3_stat_counter_signal",
  "v3_progress_bar",
  "v3_compare_bars",
  "v3_tag_live",
  "v3_tag_chip",
  "v3_location_pin",
  "v3_location_card",
  "v3_callout_line",
  "v3_highlight_sweep",
  "v3_highlight_signal",
  "v3_quote",
  "v3_quote_card",
  "v3_steps",
  "v3_cta_subscribe",
  "v3_cta_cobalt",
] as const;

function surfaceTrackingProject() {
  // Explicit synthetic manual quad: tests the authoring contract, not a tracker.
  return applyCommand(createDemoProject(), { type: "add_motion_track", track: {
    id: "surface-fixture", clipId: "clip-demo", name: "Synthetic manual quad", engine: "fixture",
    analysisFps: 30, initialRect: { x: .2, y: .2, width: .4, height: .3 }, lostRatio: 0,
    createdAt: "2026-09-01T00:00:00Z",
    points: [{ frame: 0, time: 0, rect: { x: .2, y: .2, width: .4, height: .3 }, confidence: 1,
      status: "manual", quad: [{ x: .2, y: .2 }, { x: .6, y: .2 }, { x: .6, y: .5 }, { x: .2, y: .5 }] }],
  } });
}

describe("shared motion graphic preset registry", () => {
  it("exposes exactly the 28 Motion Design v3 and 64 built-in, lower-third, travel, hologram, Studio and Wave 2 presets", () => {
    const presets = motionGraphicPresets();
    expect(EXPECTED_PRESET_IDS).toHaveLength(64);
    expect(V3_PRESET_IDS).toHaveLength(28);
    expect(presets).toHaveLength(92);
    expect(presets.map((item) => item.id).sort()).toEqual([...V3_PRESET_IDS, ...EXPECTED_PRESET_IDS].sort());
    expect(presets.slice(0, V3_PRESET_IDS.length).every((item) => item.renderer === "hao-motion-composition/v3")).toBe(true);
    expect(new Set(presets.map((item) => item.id)).size).toBe(presets.length);
    expect(presets.every((item) => item.seed.presetId === item.id && item.license && item.provenance)).toBe(true);
  });

  it("returns a compact low-token index and expands one exact editable seed on demand", () => {
    const compact = compactMotionGraphicPresets();
    expect(compact).toHaveLength(92);
    expect(new Set(compact.map((item) => item.id)).size).toBe(92);
    expect(compact.every((item) => !Object.hasOwn(item, "seed"))).toBe(true);
    expect(compact).toEqual(motionGraphicPresets().map((preset) => ({
      id: preset.id, name: preset.name, family: preset.family, license: preset.license,
      renderer: preset.renderer, kind: preset.seed.kind ?? "card", animation: preset.seed.animation ?? "fade",
      visualStyle: preset.seed.visualStyle ?? "solid_panel",
      ...(preset.seed.designV3 ? { template: preset.seed.designV3.template, textFields: MOTION_DESIGN_V3_FIELDS[preset.seed.designV3.template] } : {}),
      ...(preset.routing ? { routing: preset.routing } : {}),
    })));
    expect(findMotionGraphicPreset("v3_compare_bars")).toMatchObject({ renderer: "hao-motion-composition/v3", seed: { schema: "hao.motion-composition/v3", designV3: { template: "compare_split" } } });
    for (const item of compact) expect(findMotionGraphicPreset(item.id)).toBe(motionGraphicPresets().find((preset) => preset.id === item.id));
    const resolved = findMotionGraphicPreset("studio_marker_burst");
    expect(resolved.seed).toMatchObject({ presetId: "studio_marker_burst", kind: "title", animation: "pop" });
    expect(findMotionGraphicPreset("surface-track").seed).toMatchObject({ kind: "tag", trackingMode: "surface", animation: "fade" });
    expect(findMotionGraphicPreset("v2-word-cascade")).toMatchObject({ renderer: "hao-motion-composition/v2", seed: { schema: "hao.motion-composition/v2" } });
    expect(findMotionGraphicPreset("holo_neon_extrude")).toMatchObject({ renderer: "hao-motion-composition/v1", seed: { visualStyle: "neon_extrude_white" } });
    expect(findMotionGraphicPreset("lower_third_clean_blue_name")).toMatchObject({ renderer: "hao-motion-composition/v2", seed: { kind: "card", schema: "hao.motion-composition/v2" } });
    expect(findMotionGraphicPreset("lower_third_clean_blue_unit")).toMatchObject({ renderer: "hao-motion-composition/v2", seed: { kind: "tag", schema: "hao.motion-composition/v2" } });
  });

  it("instantiates every exact seed through real commands and JSON project validation, then edits its text", () => {
    for (const id of EXPECTED_PRESET_IDS) {
      const preset = findMotionGraphicPreset(id);
      const surface = preset.seed.trackingMode === "surface";
      const initial = surface ? surfaceTrackingProject() : createEmptyProject("Preset regression");
      const graphic = createMotionGraphic(`instance-${id}`, preset.seed.kind ?? "card", "Editkin", 0, 3,
        surface ? "surface-fixture" : undefined, preset.seed);
      const command = editorCommandSchema.parse({ type: "add_motion_graphic", graphic });
      const added = applyCommand(initial, command);
      const edited = applyCommand(added, { type: "update_motion_graphic", graphicId: graphic.id, patch: { text: "改字" } });
      const reopened = projectSchema.parse(JSON.parse(JSON.stringify(edited)));
      expect(initial.motionGraphics, id).toHaveLength(0);
      expect(added.motionGraphics[0].text, id).toBe("Editkin");
      expect(reopened.motionGraphics, id).toHaveLength(1);
      expect(reopened.motionGraphics[0].text, id).toBe("改字");
      expect(assertMotionGraphicPresetBinding(reopened.motionGraphics[0], id), id).toBe(preset);
    }
  });

  it("keeps all four pre-existing travel candidates v2 and rejects incomplete or substituted seeds", () => {
    for (const id of TRAVEL_EDITORIAL_IDS) {
      const preset = findMotionGraphicPreset(id);
      expect(preset).toMatchObject({ renderer: "hao-motion-composition/v2", license: "MIT", seed: { kind: "title" } });
      expect(preset.provenance).toContain("art review required");
      const graphic = createMotionGraphic(id, "title", "旅行", 0, 3, undefined, preset.seed);
      expect(() => editorCommandSchema.parse({ type: "add_motion_graphic", graphic: { ...graphic, layoutV2: undefined } })).toThrow();
      expect(() => assertMotionGraphicPresetBinding({ ...graphic, kind: "card" }, id)).toThrow(/未忠實解析 preset/);
      expect(() => assertMotionGraphicPresetBinding({ ...graphic, textColor: "#FF00FF" }, id)).toThrow(/未忠實解析 preset/);
    }
  });

  it("rejects surface instantiation without its track or the track's required quad", () => {
    const preset = findMotionGraphicPreset("surface-track");
    const unbound = createMotionGraphic("missing-track", "tag", "Surface", 0, 3, undefined, preset.seed);
    expect(() => applyCommand(createEmptyProject(), { type: "add_motion_graphic", graphic: unbound })).toThrow(/版面或追蹤參照不合法/);
    const missingQuad = surfaceTrackingProject();
    delete missingQuad.motionTracks[0].points[0].quad;
    const graphic = createMotionGraphic("missing-quad", "tag", "Surface", 0, 3, "surface-fixture", preset.seed);
    expect(() => applyCommand(missingQuad, { type: "add_motion_graphic", graphic })).toThrow(/版面或追蹤參照不合法/);
  });

  it("fails closed for an invented preset id", () => {
    expect(() => findMotionGraphicPreset("made-up-agent-style")).toThrow(/找不到動態圖文 preset/);
  });

  it("binds the trusted preset id to its resolved visual seed, not just its label", () => {
    const preset = findMotionGraphicPreset("studio_marker_burst");
    const graphic = createMotionGraphic("bound", "title", "可編輯文字", 0, 2, undefined, preset.seed);
    expect(assertMotionGraphicPresetBinding(graphic, preset.id).id).toBe(preset.id);
    expect(() => assertMotionGraphicPresetBinding({ ...graphic, accentColor: "#000000" }, preset.id)).toThrow(/未忠實解析 preset/);
    expect(() => assertMotionGraphicPresetBinding({ ...graphic, presetId: "studio_comic_impact" }, preset.id)).toThrow(/presetId 綁定不一致/);
  });

  it("binds nested v2 motion and rejects nested spring tampering", () => {
    const preset = findMotionGraphicPreset("v2-word-cascade");
    const graphic = createMotionGraphic("bound-v2", "title", "Shared receipt", 0, 3, undefined, preset.seed);
    expect(assertMotionGraphicPresetBinding(graphic, preset.id).renderer).toBe("hao-motion-composition/v2");
    const tampered = structuredClone(graphic);
    tampered.motionV2!.entrance.easing = { type: "linear" };
    expect(() => assertMotionGraphicPresetBinding(tampered, preset.id)).toThrow(/未忠實解析 preset/);
    expect(() => { (preset.seed.motionV2!.sequence as { staggerFrames: number }).staggerFrames = 99; }).toThrow();
    expect(findMotionGraphicPreset("v2-word-cascade").seed.motionV2!.sequence.staggerFrames).toBe(2);
  });
});
