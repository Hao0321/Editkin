import snapshot from "./styleTemplateModuleVariantsV1.json";
import type { ModuleAdapter, ModuleFormat, ModuleVariant } from "./moduleTypes";

/**
 * Manifest of graphic.style_template (editable style templates). Variants come from the slot catalogue through a
 * checked-in snapshot (styleTemplateModuleVariantsV1.json, pinned equal to styleTemplateModuleVariantSnapshotV1() by
 * test), so module metadata does not hash the template renderers. Each variant carries its slots (labels in the five UI
 * languages, limits, `component.target:consumer` bindings), artStatus and whether it renders today; prepare re-reads the
 * live catalogue, so a stale snapshot can mislabel a variant in discovery but never auto-pick it.
 */
type Manifest = ModuleAdapter["manifest"];
type Variant = ModuleVariant & { artStatus: "certified" | "pending" };
const FORMATS: ModuleFormat[] = ["portrait", "landscape"];

export function styleTemplateModuleManifestV1(): Manifest {
  const rows = snapshot.variants as unknown as Variant[];
  const variants = rows.map(row => ({ ...structuredClone(row), roles: [...(row.roles ?? [])], formats: [...(row.formats ?? FORMATS)] }));
  return {
    id: "graphic.style_template", kind: "graphic", name: "風格模板（改字・改色・改圖）", version: "1.0.0", layer: "overlay", status: "available",
    summary: "把風格模板放成一段可編輯的片段：文字、配色（palette 角色，衍生色自動跟隨）與圖片（專案圖片、影片某一格，或匯入的圖檔；可選填滿／完整與焦點）都是 slot。"
      + "prepare 內依專案尺寸與 fps 渲染（SVG → librsvg，或 mesh3d 引擎渲染層與 SVG 字合成 → ProRes，預覽即輸出），以 add_style_template_clip 加入；帶 updateClipId 則重新渲染並以 update_style_template_clip 改既有片段；帶 removeClipId 移除片段與不再有人使用的渲染（delete_clip＋delete_asset），各一步可復原。",
    formats: FORMATS, variants, roles: [...new Set(rows.flatMap(row => row.roles ?? []))].sort(),
    output: { commandTypes: ["add_style_template_clip", "update_style_template_clip", "delete_clip", "delete_asset"], carriers: ["styleTemplate"] },
    requires: [
      "startFrame (add) or updateClipId (re-render an existing template clip; slots not passed keep their values)",
      "removeClipId (alone): delete_clip plus delete_asset for its render when nothing else uses it (one Undo; slot images it imported stay); works in any chapter of a long-form set",
      "text REQUIRED to add or update (M10): the words per text slot id, from the material, never sample text; refused with STYLE_TEMPLATE_TEXT_SLOTS_REQUIRED",
      "textEvidence REQUIRED for every text slot passed (transcript cue, on-screen text, the creator's script); refused with STYLE_TEMPLATE_TEXT_EVIDENCE_REQUIRED",
      "colors optional: palette-role overrides #RRGGBB, only the roles the variant lists",
      "images optional: { source: { kind: asset, assetId } | { kind: still, assetId, time }, fit?, focal?, crop? } per image slot; rights follow the source asset",
      "variantId optional: omitted → auto-pick a certified, implemented template (filter with inputs.videoType); certified today: S4 (launch, brand_promo, music_lyric), S5 (explainer, history, news), S7 (brand_promo, launch, music_lyric, channel_trailer); a named pending template (S1) comes back artStatus uncertified; stubs are refused (STYLE_TEMPLATE_NOT_IMPLEMENTED)",
      "durationFrames optional (default: the template clip's length; update: the clip's current length)",
    ],
    invoke: { tool: "prepare_editkin_module" }, legacy: { tools: [] },
    autopilot: {
      use: "A designed template moment in the creator's own words (S1 v2 UI card; S4 3D device promo with UI screenshots and a chrome title; S5 paper-collage explainer with photo cut-outs and steps; S7 3D kinetic word, lyric band and lock-up), with real screenshots or stills of the footage; change any slot later with updateClipId. 3D templates render slower (about 1–2 s a frame at 1080p).",
      avoid: "Sample or invented text (M10); pending templates as unexamined defaults (S1 is pending: name it on purpose); a certified template outside its video types; pictures whose rights the project does not hold.",
    },
  };
}
