import type { MotionGraphic } from "../domain/types";
import type { MotionGraphicPreset } from "./motionGraphicPresetTypes";
import { initializeStudioCreativeAssets, STUDIO_MOTION_ASSETS } from "./studioAssets";
import { initializeWave2Registry } from "./wave2Registry";
import { TRAVEL_EDITORIAL_PRESETS } from "./travelEditorialPresets";
import { LOWER_THIRD_PRESETS } from "./lowerThirdPresets";

export type { MotionGraphicPreset } from "./motionGraphicPresetTypes";

let registry: MotionGraphicPreset[] | undefined;

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

const BUILTIN_MOTION_PRESETS: MotionGraphicPreset[] = [{
  id: "surface-track",
  name: "平面貼合圖卡",
  family: "動態追蹤",
  license: "MIT",
  provenance: "Editkin original procedural preset",
  renderer: "hao-motion-composition/v1",
  seed: {
    presetId: "surface-track", name: "平面貼合圖卡", kind: "tag", trackingMode: "surface",
    animation: "fade", x: .1, y: .1, width: .34, fontSize: 30, offsetX: 0, offsetY: 0,
  },
}, {
  id: "v2-word-cascade",
  name: "逐詞彈性主標",
  family: "動態文字 v2",
  license: "MIT",
  provenance: "Editkin original deterministic motion-composition/v2 preset",
  renderer: "hao-motion-composition/v2",
  seed: {
    schema: "hao.motion-composition/v2", presetId: "v2-word-cascade", name: "逐詞彈性主標", kind: "title",
    animation: "fade", x: .08, y: .12, width: .76, fontSize: 72, fontWeight: 850, letterSpacing: 0,
    outlineWidth: 3, shadowDepth: 5, cornerRadius: 18, offsetX: 0, offsetY: 0,
    textColor: "#FFFFFF", backgroundColor: "#101827E8", accentColor: "#77E4FF",
    motionV2: {
      sequence: { unit: "word", order: "forward", exitOrder: "reverse", staggerFrames: 2 },
      entrance: { durationFrames: 10, offsetXPixels: 0, offsetYPixels: 48, scale: .82, opacity: 0, easing: { type: "spring", stiffness: 170, damping: 18, mass: 1, initialVelocity: 0 } },
      exit: { durationFrames: 8, offsetXPixels: 0, offsetYPixels: -20, scale: .96, opacity: 0, easing: { type: "ease_in" } },
    },
    layoutV2: { safeArea: { top: .05, right: .05, bottom: .05, left: .05 }, maxLines: 2, minFontSize: 30, lineGap: 4, align: "left" },
  },
}];

/**
 * Original, procedural materials rendered from editable text by the native overlay
 * path. They intentionally expose no prerecorded bitmap/video dependency.
 */
export const HOLOGRAM_MOTION_PRESETS: readonly MotionGraphicPreset[] = [{
  id: "holo_prism_scan", name: "稜鏡掃描主標", family: "全息掃描", license: "MIT",
  provenance: "Editkin original procedural hologram material", renderer: "hao-motion-composition/v1",
  routing: { semanticRoles: ["hook", "chapter", "payoff"], formats: ["9:16", "16:9", "1:1"], requires: ["none"], avoidWhen: ["calm_interview", "dense_caption_region"], intensity: "high" },
  seed: { presetId: "holo_prism_scan", name: "稜鏡掃描主標", kind: "title", visualStyle: "holo_scan_cyan", animation: "fade", x: .08, y: .12, width: .76, fontSize: 70, fontFamily: "Noto Sans TC", fontWeight: 900, letterSpacing: 2, outlineWidth: 4, shadowDepth: 4, cornerRadius: 10, textColor: "#F5FEFFFF", backgroundColor: "#06141CCC", accentColor: "#52F7FFFF" },
}, {
  id: "holo_surface_grid", name: "平面網格標籤", family: "全息追蹤", license: "MIT",
  provenance: "Editkin original procedural hologram material", renderer: "hao-motion-composition/v1",
  routing: { semanticRoles: ["object_label", "proof", "location"], formats: ["9:16", "16:9", "1:1"], requires: ["none", "motion_track", "surface_quad"], avoidWhen: ["unreliable_planar_track"], intensity: "medium" },
  seed: { presetId: "holo_surface_grid", name: "平面網格標籤", kind: "tag", visualStyle: "holo_grid_lime", animation: "fade", x: .1, y: .16, width: .48, fontSize: 38, fontFamily: "Noto Sans TC", fontWeight: 800, letterSpacing: 1, outlineWidth: 3, shadowDepth: 3, cornerRadius: 8, textColor: "#F7FFF3FF", backgroundColor: "#07150ED0", accentColor: "#8BFF58FF" },
}, {
  id: "holo_target_lock", name: "目標鎖定標籤", family: "追蹤 HUD", license: "MIT",
  provenance: "Editkin original procedural HUD material", renderer: "hao-motion-composition/v1",
  routing: { semanticRoles: ["object_label", "challenge_target", "warning"], formats: ["9:16", "16:9"], requires: ["none", "motion_track"], avoidWhen: ["calm_interview", "tracking_lost"], intensity: "high" },
  seed: { presetId: "holo_target_lock", name: "目標鎖定標籤", kind: "tag", visualStyle: "target_lock_red", animation: "spring_soft", x: .62, y: .16, width: .32, fontSize: 34, fontFamily: "Noto Sans TC", fontWeight: 700, letterSpacing: 2, outlineWidth: 2, shadowDepth: 2, cornerRadius: 4, textColor: "#FFFFFFFF", backgroundColor: "#190708C8", accentColor: "#FF4D5EFF" },
}, {
  id: "holo_spectral_wire", name: "光譜線框主標", family: "全息掃描", license: "MIT",
  provenance: "Editkin original procedural wire material", renderer: "hao-motion-composition/v1",
  routing: { semanticRoles: ["hook", "chapter", "technical_explanation"], formats: ["9:16", "16:9", "1:1"], requires: ["none"], avoidWhen: ["warm_lifestyle"], intensity: "medium" },
  seed: { presetId: "holo_spectral_wire", name: "光譜線框主標", kind: "title", visualStyle: "spectral_wire_violet", animation: "slide_up", x: .08, y: .16, width: .72, fontSize: 64, fontFamily: "Noto Sans TC", fontWeight: 850, letterSpacing: 1, outlineWidth: 4, shadowDepth: 5, cornerRadius: 12, textColor: "#FFFFFFFF", backgroundColor: "#120B29CE", accentColor: "#A78BFAFF" },
}, {
  id: "holo_depth_glass", name: "深度玻璃字卡", family: "擬 3D 文字", license: "MIT",
  provenance: "Editkin original procedural depth material", renderer: "hao-motion-composition/v1",
  routing: { semanticRoles: ["proof", "fact", "comparison"], formats: ["9:16", "16:9", "1:1"], requires: ["none"], avoidWhen: ["high_motion_background"], intensity: "medium" },
  seed: { presetId: "holo_depth_glass", name: "深度玻璃字卡", kind: "card", visualStyle: "depth_glass_blue", animation: "pop", x: .08, y: .64, width: .64, fontSize: 46, fontFamily: "Noto Sans TC", fontWeight: 800, letterSpacing: 1, outlineWidth: 3, shadowDepth: 5, cornerRadius: 16, textColor: "#F4FAFFFF", backgroundColor: "#081729D4", accentColor: "#60A5FAFF" },
}, {
  id: "holo_telemetry_beam", name: "遙測光束標籤", family: "追蹤 HUD", license: "MIT",
  provenance: "Editkin original procedural telemetry material", renderer: "hao-motion-composition/v1",
  routing: { semanticRoles: ["metric", "location", "object_label"], formats: ["9:16", "16:9"], requires: ["none", "motion_track"], avoidWhen: ["no_numeric_or_entity_payload"], intensity: "medium" },
  seed: { presetId: "holo_telemetry_beam", name: "遙測光束標籤", kind: "tag", visualStyle: "telemetry_beam_amber", animation: "slide_up", x: .58, y: .7, width: .36, fontSize: 34, fontFamily: "Noto Sans TC", fontWeight: 700, letterSpacing: 2, outlineWidth: 2, shadowDepth: 3, cornerRadius: 5, textColor: "#FFF9E8FF", backgroundColor: "#1E1607D0", accentColor: "#FBBF24FF" },
}, {
  id: "holo_neon_extrude", name: "霓虹擬立體衝擊字", family: "擬 3D 文字", license: "MIT",
  provenance: "Editkin original procedural extrusion material", renderer: "hao-motion-composition/v1",
  routing: { semanticRoles: ["hook", "impact", "payoff"], formats: ["9:16", "16:9", "1:1"], requires: ["none"], avoidWhen: ["calm_interview", "long_sentence"], intensity: "high" },
  seed: { presetId: "holo_neon_extrude", name: "霓虹擬立體衝擊字", kind: "title", visualStyle: "neon_extrude_white", animation: "spring_soft", x: .08, y: .11, width: .78, fontSize: 74, fontFamily: "Noto Sans TC", fontWeight: 900, letterSpacing: 1, outlineWidth: 5, shadowDepth: 7, cornerRadius: 9, textColor: "#FFFFFFFF", backgroundColor: "#080B12D0", accentColor: "#7DD3FCFF" },
}, {
  id: "holo_quantum_label", name: "量子點陣資訊卡", family: "全息追蹤", license: "MIT",
  provenance: "Editkin original procedural particle-grid material", renderer: "hao-motion-composition/v1",
  routing: { semanticRoles: ["fact", "status", "comparison"], formats: ["9:16", "16:9", "1:1"], requires: ["none", "motion_track"], avoidWhen: ["dense_caption_region"], intensity: "medium" },
  seed: { presetId: "holo_quantum_label", name: "量子點陣資訊卡", kind: "card", visualStyle: "quantum_label_magenta", animation: "pop", x: .08, y: .66, width: .58, fontSize: 42, fontFamily: "Noto Sans TC", fontWeight: 850, letterSpacing: 1, outlineWidth: 3, shadowDepth: 4, cornerRadius: 10, textColor: "#FFF8FFFF", backgroundColor: "#210B22D0", accentColor: "#F472B6FF" },
}];

/**
 * One registry is shared by the editor UI and the MCP planner boundary. Keeping the
 * resolved seed here prevents an agent from having to reconstruct visual parameters
 * from a display name or copy the whole creative pack into context.
 */
export function motionGraphicPresets(): readonly MotionGraphicPreset[] {
  if (registry) return registry;
  initializeStudioCreativeAssets();
  const wave2 = initializeWave2Registry();
  const items: MotionGraphicPreset[] = [
    ...BUILTIN_MOTION_PRESETS.map((item) => ({ ...item, seed: { ...item.seed } })),
    ...TRAVEL_EDITORIAL_PRESETS.map((item) => ({ ...item, seed: { ...item.seed } })),
    ...LOWER_THIRD_PRESETS.flatMap((item) => [
      { id: item.nameBar.presetId!, name: item.nameBar.name!, family: `人物字幕條 · ${item.name}`, license: "MIT", provenance: "Editkin original editable lower-third preset", renderer: "hao-motion-composition/v2" as const, seed: { ...item.nameBar }, routing: { semanticRoles: ["speaker_name", "identity"], formats: ["9:16", "16:9", "1:1"] as Array<"9:16" | "16:9" | "1:1">, requires: ["none"] as Array<"none">, avoidWhen: ["identity_unverified", "dense_lower_frame"], intensity: "low" as const } },
      { id: item.unitBar.presetId!, name: item.unitBar.name!, family: `人物字幕條 · ${item.name}`, license: "MIT", provenance: "Editkin original editable lower-third preset", renderer: "hao-motion-composition/v2" as const, seed: { ...item.unitBar }, routing: { semanticRoles: ["speaker_affiliation", "identity"], formats: ["9:16", "16:9", "1:1"] as Array<"9:16" | "16:9" | "1:1">, requires: ["none"] as Array<"none">, avoidWhen: ["identity_unverified", "dense_lower_frame"], intensity: "low" as const } },
    ]),
    ...HOLOGRAM_MOTION_PRESETS.map((item) => ({ ...item, seed: { ...item.seed } })),
    ...STUDIO_MOTION_ASSETS.map((item) => ({
      id: item.id,
      name: item.name,
      family: item.family,
      license: item.license,
      provenance: item.provenance,
      renderer: "hao-motion-composition/v1" as const,
      seed: { ...item.seed },
    })),
    ...wave2.motionPresets.map((item) => ({
      id: item.id,
      name: item.name,
      family: item.family,
      license: item.license,
      provenance: item.provenance,
      renderer: "hao-motion-composition/v1" as const,
      seed: { ...item.seed },
    })),
  ];
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) throw new Error(`動態圖文 preset id 重複：${item.id}`);
    if (!item.seed.presetId || item.seed.presetId !== item.id) throw new Error(`動態圖文 preset identity 不一致：${item.id}`);
    ids.add(item.id);
  }
  registry = deepFreeze(items);
  return registry;
}

export function findMotionGraphicPreset(id: string): MotionGraphicPreset {
  const preset = motionGraphicPresets().find((item) => item.id === id);
  if (!preset) throw new Error(`找不到動態圖文 preset：${id}`);
  return preset;
}

/**
 * A preset id on an Autopilot command is only meaningful when the authored
 * graphic still contains that registered preset's resolved visual seed. This
 * fail-closed check prevents a planner from attaching a trusted id to arbitrary
 * styling while keeping text/timing/tracking as project-specific parameters.
 */
export function assertMotionGraphicPresetBinding(graphic: MotionGraphic, presetId: string): MotionGraphicPreset {
  const preset = findMotionGraphicPreset(presetId);
  if (graphic.presetId !== preset.id) throw new Error(`動態圖文 ${graphic.id} 的 presetId 綁定不一致：${preset.id}`);
  const resolved = graphic as unknown as Record<string, unknown>;
  const sameValue = (left: unknown, right: unknown): boolean => {
    if (Object.is(left, right)) return true;
    if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length && left.every((value, index) => sameValue(value, right[index]));
    if (left && right && typeof left === "object" && typeof right === "object") {
      const leftEntries = Object.entries(left as Record<string, unknown>);
      const rightRecord = right as Record<string, unknown>;
      return leftEntries.length === Object.keys(rightRecord).length && leftEntries.every(([key, value]) => Object.hasOwn(rightRecord, key) && sameValue(value, rightRecord[key]));
    }
    return false;
  };
  for (const [key, expected] of Object.entries(preset.seed)) {
    if (key === "text" || expected === undefined) continue;
    if (!sameValue(resolved[key], expected)) throw new Error(`動態圖文 ${graphic.id} 未忠實解析 preset ${preset.id}：${key}`);
  }
  return preset;
}

export function compactMotionGraphicPresets() {
  return motionGraphicPresets().map(({ id, name, family, license, renderer, seed, routing }) => ({
    id,
    name,
    family,
    license,
    renderer,
    kind: seed.kind ?? "card",
    animation: seed.animation ?? "fade",
    visualStyle: seed.visualStyle ?? "solid_panel",
    ...(routing ? { routing } : {}),
  }));
}
