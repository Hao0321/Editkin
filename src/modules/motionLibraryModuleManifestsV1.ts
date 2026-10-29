import snapshot from "./motionLibraryModuleVariantsV1.json";
import type { ModuleAdapter, ModuleFormat, ModuleVariant } from "./moduleTypes";

/**
 * Manifests of the three Motion Library modules. Variants come from the catalog through a checked-in snapshot
 * (motionLibraryModuleVariantsV1.json, pinned equal to motionLibraryModuleVariantSnapshotV1() by test), so module
 * metadata does not hash every motion library item file. Each variant carries artStatus; prepare re-reads the live
 * catalog and certifications, so a stale snapshot can mislabel a variant in discovery but never auto-picks it.
 */
type Manifest = ModuleAdapter["manifest"];
type Variant = ModuleVariant & { artStatus: "certified" | "pending" };
const FORMATS: ModuleFormat[] = ["portrait", "landscape", "square"];
const variants = (rows: readonly Variant[]): ModuleVariant[] => rows.map(row => ({ ...row, roles: [...(row.roles ?? [])], formats: [...(row.formats ?? FORMATS)] }));
const roles = (rows: readonly Variant[]) => [...new Set(rows.flatMap(row => row.roles ?? []))].sort();
const VARIANT_RULE = "variantId optional: omitted → auto-pick a certified, implemented variant (filter with inputs.family / inputs.role); a named pending variant is allowed and comes back artStatus uncertified";
const UPDATE_RULE = "updateClipId: re-render that clip in place (update_motion_library_clip, one Undo); inputs not passed keep the clip's values, a palette replaces its palette; variantId may switch to another item of the same kind";
const REMOVE_RULE = "removeClipId (alone): delete_clip plus delete_asset for its render when nothing else uses it (one Undo); works in any chapter of a long-form set";
const base = { version: "1.0.0", formats: FORMATS, invoke: { tool: "prepare_editkin_module" }, legacy: { tools: [] as string[] }, status: "available" as const };

export function motionLibraryModuleManifestsV1(): Manifest[] {
  const text = snapshot.text as Variant[], transition = snapshot.transition as Variant[], background = snapshot.background as Variant[];
  return [
    { ...base, id: "graphic.text_motion", kind: "graphic", name: "動態文字庫（Motion Library T01–T80）", layer: "overlay",
      summary: "80 種原創動態文字（衝擊、流動、縱深、切換、風格、戲劇、玩味、物理、節奏、情緒），在 prepare 內依專案尺寸與 fps 渲染成透明 ProRes 4444 快取片段，以 add_motion_library_clip 疊在畫面上。改字／配色：帶 updateClipId 重新 prepare（update_motion_library_clip，片段留在原位，一步可復原）；帶 removeClipId 移除片段與不再有人使用的渲染。",
      variants: variants(text), roles: roles(text),
      output: { commandTypes: ["add_track", "add_motion_library_clip", "update_motion_library_clip", "delete_clip", "delete_asset"], carriers: ["motionLibrary"] },
      requires: ["exactly one of startFrame (add), updateClipId or removeClipId", "durationFrames optional (default: the item's own length)", "lines REQUIRED to add (one line per entry, ≤48 characters; text from the script or footage only, never the sample text; refused with MOTION_LIBRARY_TEXT_LINES_REQUIRED)",
        UPDATE_RULE, REMOVE_RULE, VARIANT_RULE],
      autopilot: { use: "Kinetic title, hook and emphasis moments over footage, in the creator's own words. Auto-pick serves only certified variants; name a variant to choose it.",
        avoid: "T24 and every pending variant as an unexamined default; copy the material does not support." } },
    { ...base, id: "transition.motion_pair", kind: "transition", name: "動態轉場庫（Motion Library X01–X40）", layer: "timeline",
      summary: "40 種原創雙片段轉場（色面掃過、形狀擴張、流體與衝擊、面板、分割馬賽克）：prepare 依切點視窗長度渲染遮罩（與可選色層），回傳 import_asset 與 matte 核心的 set_timeline_transition；軟體輸出依遮罩逐像素混合 A／B，原生預覽會明確略過並交給軟體路徑。",
      variants: variants(transition), roles: roles(transition),
      output: { commandTypes: ["import_asset", "set_timeline_transition", "delete_timeline_transition", "delete_asset"], carriers: ["motionLibrary"] },
      requires: ["fromClipId and toClipId adjacent on one video track", "durationFrames (default 0.5 s) or beforeFrames + afterFrames, within real source handles",
        "removeTransitionId (alone): delete_timeline_transition plus delete_asset for its matte/overlay renders nothing else uses (one Undo)", VARIANT_RULE],
      autopilot: { use: "A designed cut between two adjacent clips with a narrative reason (reveal, chapter change, energy jump).",
        avoid: "Every cut; long windows that eat source handles; pending variants as defaults." } },
    { ...base, id: "background.motion_loop", kind: "background", name: "動態背景庫（Motion Library B01–B40）", layer: "clip",
      summary: "40 種原創無縫循環背景（網點、方格、線條、圖形、極簡），在 prepare 內渲染成不透明 ProRes 422 HQ 快取片段，以 add_motion_library_clip 放進影像軌（預設最底層影像軌）。帶 updateClipId 重新 prepare 改速度／密度／配色（片段留在原位）；帶 removeClipId 移除片段與不再有人使用的渲染。",
      variants: variants(background), roles: roles(background),
      output: { commandTypes: ["add_motion_library_clip", "update_motion_library_clip", "delete_clip", "delete_asset"], carriers: ["motionLibrary"] },
      requires: ["exactly one of startFrame (add), updateClipId or removeClipId", "durationFrames optional (default: the item's loop)", UPDATE_RULE, REMOVE_RULE, "trackId optional: omitted → autoTrack places the loop on motionlib-bg(-n) beneath the footage; it shows where the footage leaves a gap or is framed", VARIANT_RULE],
      autopilot: { use: "Behind title cards, chapter cards and text-only beats where no footage exists.",
        avoid: "Covering footage; flicker-prone pending variants; busy patterns under small text." } },
  ];
}
