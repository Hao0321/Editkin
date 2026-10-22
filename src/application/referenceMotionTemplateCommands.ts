import { compileFixedTemplateWindowPacketV3 } from "./fixedTemplateWindowCompilerV3";
import { compileGraphicCopyFitPacketV3, graphicCopyFitContextV3 } from "./graphicCopyFitCompilerV3";
import { compileGraphicTimingPacketV2 } from "./graphicTimingCompilerV2";
import { compileGraphicPosterPacketV3, graphicPosterContextV3 } from "./graphicPosterRangeV3";
import { compileGraphicHoldBeatPacketV3 } from "./graphicHoldBeatV3";
import type { EditorCommand } from "../domain/commandTypes";
import { motionGraphicV2ExitStaggerFrames, motionGraphicV2UnitCount } from "../domain/motionCompositionV2Contract";
import type { ClipLayout, EditProject, FloatingVideoFrame, KeyframeEasing, MediaAsset, MotionGraphic, MotionVectorShapeCommand, NormalizedRect, TimelineClip, Transform2D } from "../domain/types";
import { compileDesignThemeScene, type DesignBeat, type DesignMask, type DesignType } from "./referenceMotionDesignThemes";
import { DEFAULT_TRANSFORM } from "../domain/types";
import { createClipMask } from "../domain/masks";
import { applyCommand } from "../domain/commands";
import { projectDuration } from "../domain/editGraph";
import { strictMediaColorInterpretation } from "./sourceDisplayMetadata";
import { resolveBundledFontFace } from "../typography/fontFaces";
import type { MotionPresetVariant } from "../domain/schema";
import { validateMotionSceneStyle } from "../domain/motionSceneStyle";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { createMotionGraphic } from "../motion/composition";
import { motionGraphicV2LayoutReceipt, prepareMotionGraphicV2FrameLayout, type MotionGraphicV2LayoutReceipt } from "../motion/compositionV2";
import { CONNECTION_FIELD_GROUP_CENTERS } from "../motion/connectionField";
import { floatingFrameLayout, type FloatingFrameLayout } from "../motion/floatingVideoFrame";
import { compileGraphicCadence, GRAPHIC_CADENCE_KINETIC_CONTRACT } from "../motion/graphicCadence";
import { MOTION_CURVES, kineticTextMotion } from "../motion/motionLanguage";
import { DEFAULT_REFERENCE_MOTION_STYLE, DEFAULT_REFERENCE_NETWORK_COLORS, REFERENCE_MOTION_COLOR_POLICY, REFERENCE_MOTION_SOURCE_OVERLAY_CONTRACT, REFERENCE_MOTION_SOURCE_OVERLAY_V2_CONTRACT, REFERENCE_MOTION_EDITORIAL_CONTRACT, REFERENCE_MOTION_SOURCE_BACKDROP_CONTRACT, REFERENCE_MOTION_NATIVE_PAINT_PRESENTATION_CONTRACT, REFERENCE_MOTION_DISPLAY_PAINT_PRESENTATION_CONTRACT, isNativeReferenceMotionPresentation, referenceMotionTemplate, referenceMotionTemplateInputSchema, type ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";

type Overrides = MotionPresetVariant["overrides"];
export interface ReferenceMotionGraphicBinding {
  graphic: MotionGraphic; presetId: string; overrides: Overrides; startFrame: number; endFrame: number;
}
export interface ReferenceMotionTemplateRole {
  key: string;
  kind: "graphic" | "clip" | "track" | "mask" | "keyframe";
  id: string;
  parentId?: string;
}
/** A narrative beat a design theme declared where it drew its roles (one-tool Short, M1 design §5.1). Project frames:
 * a beat ends where the next one starts, the last at the template's end; every compiled role is in exactly one beat. */
export interface ReferenceMotionTemplateBeat {
  id: string;
  narrativeRole: DesignBeat["narrativeRole"];
  designRole: DesignBeat["designRole"];
  startFrame: number;
  endFrame: number;
  roleKeys: string[];
}
export interface ReferenceMotionFloatingMediaBinding {
  clipId: string; assetId: string; sourceStart: number; role: string;
  floatingFrame: Extract<FloatingVideoFrame, { schema: "editkin.floating-video-frame/v2" }>;
  layout: FloatingFrameLayout;
}
export interface ReferenceMotionTemplateCompileOptions {
  generation: 2;
  /** The authoring wrapper supplies a current layout made from a real prepared
   * glyph run. This synchronous seam performs no byte reads or async work. */
  layoutForGraphic: (graphic: MotionGraphic) => MotionGraphicV2LayoutReceipt;
  /** Semantic identity is independent of call order and mutable frame timing. */
  allocateRoleId?: (role: Omit<ReferenceMotionTemplateRole, "id">, prefix: string) => string;
  /** Told which owned, frame-ready layout a supplied layout became, so a wrapper that compiles the same graphic again
   * (a pass resumed after a new glyph run) can supply that prepared layout and skip re-copying and re-hashing it. */
  rememberPreparedLayout?: (supplied: MotionGraphicV2LayoutReceipt, prepared: MotionGraphicV2LayoutReceipt) => void;
}

const transparent = "#00000000";

function contrast(a: string, b: string) {
  const luminance = (hex: string) => {
    const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
    return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  };
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}

/** Layout is in the normalized, contain-padded project canvas used by formal rendering. */
export function motionSourceLayout(project: Pick<EditProject, "width" | "height">, asset: Pick<MediaAsset, "width" | "height" | "displayAspectRatio">, region: NormalizedRect): ClipLayout {
  if (!asset.width || !asset.height || !Number.isFinite(asset.width) || !Number.isFinite(asset.height)
    || asset.width <= 0 || asset.height <= 0) throw new Error("素材槽需要已探測的有效寬高");
  if (asset.displayAspectRatio !== undefined && (!Number.isFinite(asset.displayAspectRatio) || asset.displayAspectRatio <= 0)) {
    throw new Error("素材槽已宣告的 display aspect ratio 必須有效");
  }
  const ratio = asset.displayAspectRatio ?? asset.width / asset.height, canvasRatio = project.width / project.height;
  const cropWidth = Math.min(1, ratio / canvasRatio), cropHeight = Math.min(1, canvasRatio / ratio);
  const scale = Math.min(region.width / cropWidth, region.height / cropHeight);
  const width = cropWidth * scale, height = cropHeight * scale;
  return { crop: { x: (1 - cropWidth) / 2, y: (1 - cropHeight) / 2, width: cropWidth, height: cropHeight },
    viewport: { x: region.x + (region.width - width) / 2, y: region.y + (region.height - height) / 2, width, height } };
}

/** Explicit Rec.709 keeps the original rule. Camera `auto`/`hlg` media is admitted only with complete, consistent
 * BT.709 or BT.2100 HLG tags and only in a rec709-mode project, where the formal compositor applies its verified
 * display transform (HLG shoulder before the 8-bit surface). It is never relabelled SDR; ACES2, native paint, PQ,
 * Log and incomplete tags stay rejected. */
export function referenceMotionTemplateSourceColorAdmitted(project: EditProject, asset: MediaAsset, nativePaint: boolean): boolean {
  const interpretation = asset.color?.interpretation ?? "rec709";
  if (interpretation === "rec709") return true;
  if ((interpretation !== "auto" && interpretation !== "hlg") || !asset.color || nativePaint
    || (project.colorManagement?.mode ?? "rec709") !== "rec709") return false;
  try {
    const display = strictMediaColorInterpretation(asset.color);
    return display === "hlg" || (display === "rec709" && interpretation === "auto");
  } catch { return false; }
}

/** Pure compound scene compiler used by the inspector and MCP. Nothing executes or reads files here. */
function buildReferenceMotionTemplateCommandsV1(project: EditProject, raw: ReferenceMotionTemplateInput, idFactory: (prefix: string) => string,
  options?: ReferenceMotionTemplateCompileOptions) {
  if (options !== undefined && (options.generation !== 2 || typeof options.layoutForGraphic !== "function")) {
    throw new Error("Motion generation 2 requires a physical layout provider");
  }
  const input = referenceMotionTemplateInputSchema.parse(raw);
  const nativePaint = isNativeReferenceMotionPresentation(input.graphicPresentation);
  const displayPaint = input.graphicPresentation === "native_paint_display_v2";
  const nativePaintContract = displayPaint ? REFERENCE_MOTION_DISPLAY_PAINT_PRESENTATION_CONTRACT : REFERENCE_MOTION_NATIVE_PAINT_PRESENTATION_CONTRACT;
  if (nativePaint && (options?.generation !== 2 || project.colorManagement?.mode !== "aces2"
    || project.colorManagement.outputTransform !== "rec709_sdr"
    || project.motionGraphics.some(graphic => !graphic.paintV1 || graphic.visualStyle !== "native_paint"))) {
    throw new Error("Native paint template requires generation 2, actual physical glyphs and an all-native-paint ACES2 rec709_sdr project");
  }
  if (input.graphicCadence === "brisk" && options?.generation !== 2) {
    throw new Error("Brisk graphic cadence requires generation 2 and a physical layout provider");
  }
  if (input.graphicCadence === "kinetic" && options?.generation !== 2) {
    throw new Error("Kinetic graphic cadence requires generation 2 and a physical layout provider");
  }
  if (input.strikePresentation === "semantic_replace_v1" && options?.generation !== 2) {
    throw new Error("semantic_replace_v1 requires generation 2 and a physical layout provider");
  }
  if (input.mediaPresentation === "source_soft_v2" && (input.templateId !== "comparison_pair" || input.focusRegion !== undefined)) {
    throw new Error("source_soft_v2 只適用無主體裁切的 comparison_pair");
  }
  if (input.mediaPresentation === "source_soft_v2" && options?.generation !== 2) {
    throw new Error("source_soft_v2 requires generation 2 and a physical layout provider");
  }
  const recipe = referenceMotionTemplate(input.templateId), fps = project.fps, portrait = project.height > project.width;
  if (Math.min(project.width, project.height) < 256) throw new Error("Motion 模板需要短邊至少 256 的畫布");
  if (!portrait && input.intent !== "standalone_showcase") throw new Error("長片保留完整素材；整幕 Motion 只能明確指定 standalone_showcase，局部提示請用 prepare_native_motion_sequence");
  if (project.scene3d?.enabled || project.scene25d?.enabled || project.colorManagement?.mode === "aces2" && !nativePaint) throw new Error("此模板需要一般 Rec.709 2D 專案；不是原生 3D 或 ACES 模板");
  if (input.durationFrames < Math.ceil(recipe.minSeconds * fps) || input.startFrame + input.durationFrames > Math.round(projectDuration(project) * fps)) throw new Error("模板範圍超出專案或沒有留下動作與閱讀停留");
  const track = project.tracks.find(track => track.kind === "video" && !track.locked && !track.hidden && track.clips.some(c => c.id === input.clipId));
  const original = track?.clips.find(c => c.id === input.clipId);
  const mainAsset = project.assets.find(a => a.id === original?.assetId);
  if (!original || !mainAsset || mainAsset.kind !== "video" || mainAsset.compositionId) throw new Error("模板需要可編輯的真實影片 clipId");
  if (Math.round(original.timelineStart * fps) !== input.startFrame || Math.round(original.duration * fps) !== input.durationFrames) throw new Error("模板範圍必須精確對應片段；先用原生剪裁命令準備該段");
  if (project.motionGraphics.some(g => g.timelineStart < (input.startFrame + input.durationFrames) / fps && g.timelineStart + g.duration > input.startFrame / fps)) throw new Error("此段已有 Motion；請局部修訂或先移除，避免重複套用與文字重疊");
  if (input.sources.length < recipe.sourceSlots || input.sources.length > recipe.maxSources) throw new Error(`模板需要 ${recipe.sourceSlots} 至 ${recipe.maxSources} 個額外獨立素材槽`);
  const sources = [{ assetId: mainAsset.id, sourceStart: original.sourceStart, label: input.primaryLabel ?? "主要素材" }, ...input.sources];
  const sourceAssets = sources.map(slot => {
    const asset = project.assets.find(a => a.id === slot.assetId);
    if (!asset || asset.kind !== "video" || asset.compositionId || !referenceMotionTemplateSourceColorAdmitted(project, asset, nativePaint)
      || !Number.isFinite(slot.sourceStart) || slot.sourceStart < 0 || slot.sourceStart + input.durationFrames / fps > asset.duration + 1e-6) throw new Error("素材槽缺少 Rec.709 真影片、有效入點或足夠長度");
    return asset;
  });
  const paths = sourceAssets.map(a => decodeURI(a.uri).replace(/\\/g, "/").replace(/^file:\/*/i, "").toLowerCase());
  if (new Set(paths).size !== paths.length || new Set(sources.map(s => s.assetId)).size !== sources.length) throw new Error("獨立素材不可重複或用同檔案別名冒充不同證據");
  const visual = ["comparison_pair", "evidence_takeover", "focus_wall", "brand_recap"].includes(input.templateId);
  if (visual && (original.keyframes.length || original.floatingFrame || original.layout || original.transform3d || original.layer?.parentClipId
    || original.masks?.some(m => m.enabled) || original.chromaKey?.enabled || Object.keys(original.expressions ?? {}).length
    || Object.keys(DEFAULT_TRANSFORM).some(k => original.transform[k as keyof Transform2D] !== DEFAULT_TRANSFORM[k as keyof Transform2D])
    || original.creative?.transitionIn || original.creative?.transitionOut)) throw new Error("素材編排需要乾淨片段；既有動畫、遮罩、透視與版面必須先另行處理");
  if (["context_stack", "brand_recap"].includes(input.templateId) && !input.items) throw new Error("資訊組裝與回顧需要 2 至 4 份核對過的短資訊");
  if (input.templateId === "kinetic_network" && (input.items?.length !== 3 || input.items.some(item => [...item.label].length > 8))) throw new Error("能力連結需要三幕，每幕主短語最多 8 字");
  if (input.templateId === "stat_reveal" && (!input.items || input.items.some(item => !/\d/.test(item.label) || [...item.label].length > 12))) {
    throw new Error("數據揭示需要 2 至 4 份含真實數字的核對數據，每個數字最多 12 字");
  }
  if (input.templateId === "statement_cut" && (!input.items || input.items.some(item => [...item.label].length > 8))) throw new Error("宣言快切需要 2 至 4 個主張，每個最多 8 字");
  if (input.templateId === "stat_cycle" && (!input.items || input.items.some(item => !/\d/.test(item.label) || [...item.label].length > 12))) {
    throw new Error("大數字輪播需要 2 至 4 份含真實數字的核對數據，每個數字最多 12 字");
  }
  if (input.templateId === "word_cycle" && (!input.items || input.items.some(item => [...item.label].length > 8))) throw new Error("字詞輪播需要 2 至 4 個詞，每個最多 8 字");
  if (input.templateId === "word_build" && `${input.title} ${input.subtitle ?? ""}`.trim().split(/\s+/).length < 2) throw new Error("逐字標題需要至少兩個以空格分開的詞");
  if (input.templateId === "logo_end" && !input.brandMark) throw new Error("片尾 Logo 需要文字字標 brandMark");
  if (input.templateId === "ranked_list" && (!input.items || input.items.some(item => item.detail !== undefined && (!/\d/.test(item.detail) || [...item.detail].length > 8)))) {
    throw new Error("排行清單需要 2 至 4 列；分數必須是真實數字，最多 8 字");
  }
  if (input.templateId === "ui_demo" && (!input.items || !input.primaryLabel
    || input.items.some(item => [...item.label].length > 12 || (item.detail !== undefined && [...item.detail].length > 10)))) {
    throw new Error("介面示範需要 2 至 4 個設定列（每列最多 12 字、值最多 10 字）與按鈕文字 primaryLabel");
  }
  if (input.network && input.templateId !== "kinetic_network") throw new Error("network 參數只適用能力連結場景");
  // An observed subject range crops the primary footage window (Shorts v2: a portrait source fills the width instead of
  // standing as a narrow strip). Design themes take it on every single-window family; the source never re-times.
  if (input.focusRegion && input.templateId !== "brand_recap"
    && !(input.designSystem !== undefined && ["strike_reframe", "level_bridge", "context_stack"].includes(input.templateId))) {
    throw new Error("主體取景只適用素材回顧與設計主題的單一影像窗場景");
  }
  if (input.templateId === "strike_reframe" && !input.previousText) throw new Error("刪線模板需要原句 previousText，不能替觀眾捏造誤解");
  // Admit every measured source aperture before any physical glyph request.
  const softComparison = input.mediaPresentation === "source_soft_v2" ? sourceAssets.map((asset, index) => {
    if (!Number.isInteger(asset.width) || !Number.isInteger(asset.height) || asset.width! <= 0 || asset.height! <= 0
      || !Number.isFinite(asset.displayAspectRatio) || asset.displayAspectRatio! <= 0) {
      throw new Error("source_soft_v2 需要已探測的有效直立 display aspect ratio 與來源寬高");
    }
    const region = portrait ? { x: index === 0 ? .065 : .53, y: .29, width: .405, height: .43 }
      : { x: index === 0 ? .065 : .53, y: .29, width: .405, height: .46 };
    const floatingFrame: ReferenceMotionFloatingMediaBinding["floatingFrame"] = {
      schema: "editkin.floating-video-frame/v2", style: "matte", aspect: "source", mediaFit: "contain",
      size: Math.min(region.width, region.height), centerX: region.x + region.width / 2, centerY: region.y + region.height / 2,
      yawDegrees: 0, pitchDegrees: 0, motion: { entranceFrames: 0, exitFrames: 0, travelY: 0 },
    };
    const layout = floatingFrameLayout(floatingFrame, project.width, project.height,
      { width: asset.displayAspectRatio!, height: 1, fps, durationFrames: input.durationFrames, localFrame: 0 });
    return { floatingFrame, layout };
  }) : undefined;
  const style = validateMotionSceneStyle(input.style ?? (input.templateId === "kinetic_network" ? { ...DEFAULT_REFERENCE_MOTION_STYLE,
    typography: { ...DEFAULT_REFERENCE_MOTION_STYLE.typography, headingFamily: "Noto Sans TC" } } : DEFAULT_REFERENCE_MOTION_STYLE)), unit = Math.min(project.width, project.height) / 1080;
  if (contrast(style.palette.surface, style.palette.text) < 4.5 || contrast(style.palette.surface, style.palette.muted) < 3) throw new Error("品牌文字與底色對比不足，請調整 palette 的 text／muted／surface");
  // "brisk" is the generation-2 phase family; kinetic adds the Motion Language shape.
  const cadence = compileGraphicCadence(fps, style.animationSpeed, input.graphicCadence), brisk = cadence.profile !== "legacy";
  const kinetic = cadence.profile === "kinetic", travel = kinetic ? GRAPHIC_CADENCE_KINETIC_CONTRACT.shape.travelMultiplier : 1;
  const readingFrames = (text: string) => Math.ceil((.65 + [...text].length / 8) * fps);
  const entrance = cadence.entranceFrames, exit = cadence.exitFrames, move = cadence.moveFrames;
  const commands: EditorCommand[] = [], bindings: ReferenceMotionGraphicBinding[] = [];
  const roles: ReferenceMotionTemplateRole[] = [];
  // Narrative beats a design theme declares while it draws; each role records the beat open at its creation (metadata only).
  const beatSpecs: DesignBeat[] = [], beatOfRoleKey = new Map<string, string | undefined>();
  let currentBeat: string | undefined;
  function roleId(key: string, kind: ReferenceMotionTemplateRole["kind"], prefix: string, parentId?: string, existingId?: string) {
    if (roles.some(role => role.key === key)) throw new Error(`Duplicate template semantic role: ${key}`);
    const role = { key, kind, ...(parentId === undefined ? {} : { parentId }) };
    const id = existingId ?? options?.allocateRoleId?.(role, prefix) ?? idFactory(prefix);
    if (!id || roles.some(previous => previous.id === id)) throw new Error(`Duplicate or missing template role identity: ${key}`);
    roles.push({ ...role, id }); beatOfRoleKey.set(key, currentBeat); return id;
  }
  const phases: Array<{ role: "reveal" | "hold" | "focus" | "return"; startFrame: number; endFrame: number }> = [];
  const fullEntrances: Array<{ startFrame: number; endFrame: number; graphicEndFrame: number; exitStartFrame?: number }> = [];
  const layouts: ReturnType<typeof motionGraphicV2LayoutReceipt>[] = [];
  const mediaBindings: Array<{ clipId: string; assetId: string; sourceStart: number; role: string; layout: ClipLayout }> = [];
  const floatingMediaBindings: ReferenceMotionFloatingMediaBinding[] = [];
  const safeArea = { top: 0, right: 0, bottom: 0, left: 0 };
  function motion(inFrames = entrance, outFrames = exit, dy = 12 * unit, dx = 0) {
    // Monotone expo-out / snap-in keep the source-overlay envelope exact; no
    // blur or rotation because vector rules and panels share this helper.
    if (kinetic) return { sequence: { unit: "all" as const, order: "forward" as const, exitOrder: "forward" as const, staggerFrames: 0, scaleOrigin: "center" as const },
      entrance: { durationFrames: inFrames, offsetXPixels: dx * travel, offsetYPixels: dy * travel, scale: GRAPHIC_CADENCE_KINETIC_CONTRACT.shape.entranceScale, opacity: 0, easing: MOTION_CURVES.expoOut },
      exit: { durationFrames: outFrames, offsetXPixels: 0, offsetYPixels: 0, scale: 1, opacity: 0, easing: MOTION_CURVES.snapIn } };
    return { sequence: { unit: "all" as const, order: "forward" as const, exitOrder: "forward" as const, staggerFrames: 0 },
      entrance: { durationFrames: inFrames, offsetXPixels: dx, offsetYPixels: dy, scale: 1, opacity: 0, easing: { type: "ease_out" as const } },
      exit: { durationFrames: outFrames, offsetXPixels: 0, offsetYPixels: 0, scale: 1, opacity: 0, easing: { type: "ease_in" as const } } };
  }
  // flash: a count-up step held for a frame or two; its number is a passing value, not copy to read.
  function add(role: string, presetId: string, text: string, overrides: Overrides, start = 0, end = input.durationFrames, flash = false) {
    if (end <= start) throw new Error("Motion 元素沒有有效範圍");
    const preset = findMotionGraphicPreset(presetId);
    const complete: Overrides = { name: `${recipe.name} · ${text ? text.slice(0, 14) : preset.name}`, backgroundColor: transparent, accentColor: transparent, outlineWidth: 0, shadowDepth: 0,
      fontFamily: style.typography.headingFamily, textColor: style.palette.text, letterSpacing: 0, fontWeight: 700,
      motionV2: motion(), layoutV2: { safeArea, maxLines: 2, minFontSize: Math.max(8, 36 * unit), lineGap: 8 * unit, align: "left" }, ...overrides };
    // A graphic that lasts to the template's own end holds its finished state: the scene cuts as one piece, so its last
    // frame is the settled design (a Short loops back to its first frame) instead of half-faded leftovers beside the footage.
    if (end === input.durationFrames && complete.motionV2) {
      const held = complete.motionV2, out = held.exit;
      // A slow drift that ends fully visible and near its place (a hold that still breathes) is kept; anything that would
      // fade, shrink or fly away a frame before the cut is held complete instead.
      // (32 design pixels: the limit scales with the canvas like the drift itself.)
      const drift = out.opacity === 1 && out.durationFrames > 1 && !held.sequence.exitStaggerFrames && Math.abs(out.offsetXPixels) <= 32 * unit
        && Math.abs(out.offsetYPixels) <= 32 * unit && Math.abs(out.scale - 1) <= .08;
      if (!drift) {
        const sequence = held.sequence.exitStaggerFrames ? { ...held.sequence, exitStaggerFrames: 0 } : held.sequence;
        complete.motionV2 = { ...held, sequence, exit: { durationFrames: 1, offsetXPixels: 0, offsetYPixels: 0, scale: 1, opacity: 1, easing: held.exit.easing } };
      }
    }
    // Motion Language: kinetic headlines cascade per character and exit together;
    // labels, counters, vectors and native paint stay whole. A scene without room
    // for the cascade tail plus its reading hold keeps the whole-line entrance.
    const headline = complete.motionV2;
    if (kinetic && !nativePaint && text && !complete.vectorV2 && headline && headline.sequence.unit === "all"
      && headline.entrance.durationFrames > 1 && (complete.fontSize ?? 0) >= 64 * unit) {
      const units = Math.min(128, motionGraphicV2UnitCount({ text, motionV2: { sequence: { unit: "character" } } }));
      const stagger = cadence.staggerFrames(units);
      const room = end - start - headline.entrance.durationFrames - (units - 1) * stagger - headline.exit.durationFrames;
      if (stagger > 0 && room >= readingFrames(text)) complete.motionV2 = { ...headline, sequence: { ...headline.sequence, unit: "character", staggerFrames: stagger, exitStaggerFrames: 0 } };
    }
    if (nativePaint) {
      const contract = nativePaintContract;
      if (project.motionGraphics.length + bindings.length + 1 > contract.maxProjectGraphics) throw new Error("Native paint template exceeds the current four-graphic project budget");
      complete.visualStyle = "native_paint";
      complete.paintV1 = { ...(displayPaint ? { schema: "editkin.motion-paint/v2" as const, colorIntent: "display_rec709_sdr" as const }
        : { schema: "editkin.motion-paint/v1" as const }), clips: [],
        fill: { kind: "solid", color: text ? complete.textColor! : complete.backgroundColor! },
        ...(!text ? { stroke: { color: `${style.palette.separator}${contract.panelStrokeAlpha}`, widthPixels: Math.max(.25, contract.panelStrokePixels1080 * unit) },
          shadow: { color: contract.panelShadowColor, blurPixels: contract.panelShadowPixels1080.blur * unit,
            offsetXPixels: contract.panelShadowPixels1080.x * unit, offsetYPixels: contract.panelShadowPixels1080.y * unit } } : {}) };
      complete.backgroundColor = transparent;
    }
    if (!flash && text && end - start - complete.motionV2!.entrance.durationFrames - complete.motionV2!.exit.durationFrames < readingFrames(text)) throw new Error(`文字「${text}」缺少閱讀停留；延長片段或縮短文字`);
    const graphic: MotionGraphic = { ...createMotionGraphic(roleId(role, "graphic", "motion-template"), preset.seed.kind ?? "card", text,
      (input.startFrame + start) / fps, (end - start) / fps, undefined, preset.seed), ...structuredClone(complete) };
    let receipt: MotionGraphicV2LayoutReceipt;
    if (options && !graphic.vectorV2) {
      const supplied = options.layoutForGraphic(graphic);
      if (!supplied?.physicalFont || !Array.isArray(supplied.segments) || !supplied.segments.length
        || supplied.segments.some(segment => !segment.outline || !segment.outline.svg || !segment.outline.ass || !segment.outline.ink)) {
        throw new Error(`Motion generation 2 graphic ${graphic.id} requires a physical glyph layout with shared outlines; estimated fallback is unsupported`);
      }
      receipt = prepareMotionGraphicV2FrameLayout(project, graphic, supplied);
      options.rememberPreparedLayout?.(supplied, receipt);
    } else receipt = motionGraphicV2LayoutReceipt(project, graphic);
    const fullEntrance = graphic.motionV2!.entrance.durationFrames + Math.max(0, receipt.unitCount - 1) * graphic.motionV2!.sequence.staggerFrames;
    const fullExit = graphic.motionV2!.exit.durationFrames + Math.max(0, receipt.unitCount - 1) * motionGraphicV2ExitStaggerFrames(graphic.motionV2!);
    if (!flash && text && end - start - fullEntrance - fullExit < readingFrames(text)) throw new Error(`文字「${text}」缺少完整入場後的閱讀停留；延長片段或縮短文字`);
    const exitPhase = graphic.motionV2!.exit;
    const exitsVisibly = exitPhase.opacity !== 1 || exitPhase.scale !== 1 || exitPhase.offsetXPixels !== 0 || exitPhase.offsetYPixels !== 0;
    fullEntrances.push({ startFrame: input.startFrame + start,
      endFrame: input.startFrame + start + Math.max(fullEntrance, graphic.vectorV2?.revealFrames ?? 1),
      graphicEndFrame: input.startFrame + end,
      ...(exitsVisibly ? { exitStartFrame: input.startFrame + end - fullExit } : {}) });
    layouts.push(receipt); bindings.push({ graphic, presetId, overrides: complete, startFrame: input.startFrame + start, endFrame: input.startFrame + end });
    commands.push({ type: "add_motion_graphic", graphic });
    return graphic;
  }
  function panel(role: string, region: NormalizedRect, start = 0, end = input.durationFrames, color = style.palette.surface, reveal = false, dx = 0, compositeLayer: "background" | "foreground" = "foreground", grid = true) {
    const vectorSchema = compositeLayer === "background" ? "editkin.motion-vector-stage/v1" as const : "editkin.motion-vector/v1" as const;
    const background = add(role, "reel_native_panel", "", { ...(options?.generation === 2 ? { x: region.x, y: region.y, width: region.width } : region), compositeLayer, backgroundColor: color, accentColor: transparent, fontSize: 8, cornerRadius: region.x === 0 && region.width === 1 ? 0 : 16 * unit,
      layoutV2: { safeArea, maxLines: 1, minFontSize: 8, lineGap: 0, align: "left" }, motionV2: reveal ? motion(entrance, exit, 0, dx) : {
        ...motion(1, 1, 0), entrance: { ...motion().entrance, durationFrames: 1, opacity: 1, offsetYPixels: 0 }, exit: { ...motion().exit, durationFrames: 1, opacity: 1 } },
      vectorV2: { schema: vectorSchema, kind: "panel", heightPixels: region.height * project.height, revealFrames: 1 } }, start, end);
    if (grid && region.x === 0 && region.width === 1 && color === style.palette.surface && !reveal) add(`${role}:grid`, "reel_line_grid", "", {
      ...(options?.generation === 2 ? { x: region.x, y: region.y, width: region.width } : region), compositeLayer, fontSize: 8, textColor: `${style.palette.accent}30`, accentColor: `${style.palette.accent}1C`,
      layoutV2: { safeArea, maxLines: 1, minFontSize: 8, lineGap: 0, align: "left" },
      motionV2: { ...motion(1, 1, 0), entrance: { ...motion().entrance, durationFrames: 1, opacity: 1, offsetYPixels: 0 }, exit: { ...motion().exit, durationFrames: 1, opacity: 1 } },
      vectorV2: { schema: vectorSchema, kind: "line_grid", heightPixels: region.height * project.height, revealFrames: 1,
        spacingPixels: 72 * unit, lineWidthPixels: Math.max(.25, unit), majorEvery: 4 } }, start, end);
    return background;
  }
  function text(role: string, value: string, x: number, y: number, width: number, size = 68, start = 0, end = input.durationFrames, color = style.palette.text, maxLines = 2) {
    // The layout fitter visits integer font sizes. A fractional minimum above
    // floor(fontSize) otherwise rejects even a short readable label on a small canvas.
    return add(role, "reel_spatial_headline", value, { x, y, width, fontSize: Math.max(8, size * unit), textColor: color, fontFamily: size <= 40 ? style.typography.bodyFamily : style.typography.headingFamily,
      layoutV2: { safeArea, maxLines, minFontSize: Math.max(8, Math.floor(Math.min(size, 36) * unit)), lineGap: 8 * unit, align: "left" } }, start, end);
  }
  function header(end = input.durationFrames) {
    panel("header:panel", { x: 0, y: 0, width: 1, height: .235 }, 0, end);
    if (input.kicker) text("kicker", input.kicker, .07, .035, .86, 28, 0, end, style.palette.accent, 1);
    text("headline", input.title, .065, input.kicker ? .082 : .065, .87, portrait ? 76 : 68, 0, end);
  }
  function animate(role: string, clip: TimelineClip, points: Array<{ key: string; frame: number; transform?: Partial<Transform2D>; easing?: KeyframeEasing }>) {
    const ordered = new Map(points.map(p => [p.frame, p]));
    for (const point of [...ordered.values()].sort((a, b) => a.frame - b.frame)) commands.push({ type: "add_keyframe", clipId: clip.id,
      keyframe: { id: roleId(`${role}:${point.key}`, "keyframe", "motion-key", clip.id), time: point.frame / fps, transform: { ...DEFAULT_TRANSFORM, ...point.transform }, color: structuredClone(clip.color), easing: point.easing ?? "ease_in_out" } });
  }
  function place(index: number, region: NormalizedRect, role: string, clone = false, focus?: NormalizedRect, key?: string, maskShape?: DesignMask) {
    const slot = sources[index], asset = sourceAssets[index], layout = motionSourceLayout(project, asset, region);
    if (focus) {
      const bounds = layout.crop;
      if (focus.x < bounds.x - 1e-8 || focus.y < bounds.y - 1e-8 || focus.x + focus.width > bounds.x + bounds.width + 1e-8 || focus.y + focus.height > bounds.y + bounds.height + 1e-8) throw new Error("主體範圍必須在實際來源內，不可取 letterbox 或猜測素材內容");
      const factor = Math.min(region.width / focus.width, region.height / focus.height);
      layout.crop = focus;
      layout.viewport = { x: region.x + (region.width - focus.width * factor) / 2, y: region.y + (region.height - focus.height * factor) / 2,
        width: focus.width * factor, height: focus.height * factor };
    }
    let clip = original!;
    const semanticRole = key ?? (clone ? `source:${index}:foreground` : `source:${index}`);
    if (index > 0 || clone) {
      const trackId = roleId(`${semanticRole}:track`, "track", "motion-source-track");
      clip = { ...structuredClone(original!), id: roleId(`${semanticRole}:clip`, "clip", "motion-source-clip", trackId), trackId, assetId: slot.assetId,
        sourceStart: slot.sourceStart, volume: 0, layout, keyframes: [], transform: { ...DEFAULT_TRANSFORM },
        layer: { enabled: true, blendMode: "normal", role: "content" } };
      commands.push({ type: "add_track", track: { id: trackId, name: role, kind: "video", locked: false, muted: false, clips: [] } }, { type: "add_clip", clip });
    } else {
      roleId(`${semanticRole}:clip`, "clip", "motion-source-clip", original!.trackId, original!.id);
      commands.push({ type: "set_clip_layout", clipId: original!.id, layout });
    }
    const mask = createClipMask(roleId(`${semanticRole}:mask`, "mask", "motion-edge", clip.id), "polygon"), crop = layout.crop;
    mask.name = maskShape?.shape === "arch" ? "影片拱形窗" : maskShape?.shape === "chamfer" ? "影片切角窗" : "影片窗柔和圓角"; mask.feather = .0015; mask.expansion = 0; mask.refine.chatterReduction = 0;
    // Mask space is the contain-fitted canvas; an output-pixel radius is divided by the window's scale.
    const windowScale = layout.viewport.width / crop.width;
    const radius = maskShape?.radiusPixels !== undefined ? maskShape.radiusPixels / windowScale : 32 * unit;
    const rx = Math.min(crop.width / 8, radius / project.width), ry = Math.min(crop.height / 8, radius / project.height);
    const clamp = (value: number) => Math.max(0, Math.min(1, value));
    if (maskShape?.shape === "arch") {
      // A semicircular head as wide as the window over straight sides and a square foot.
      const ax = crop.width / 2, ay = Math.min(crop.height / 2, crop.width * project.width / (2 * project.height)), cx = crop.x + ax, cy = crop.y + ay;
      mask.path = [{ id: "foot-left", x: clamp(crop.x), y: clamp(crop.y + crop.height) },
        ...Array.from({ length: 25 }, (_, step) => { const theta = Math.PI + step * Math.PI / 24;
          return { id: `arch-${step}`, x: clamp(cx + ax * Math.cos(theta)), y: clamp(cy + ay * Math.sin(theta)) }; }),
        { id: "foot-right", x: clamp(crop.x + crop.width), y: clamp(crop.y + crop.height) }];
    } else if (maskShape?.shape === "chamfer") {
      // Cut top-left and bottom-right corners (HUD window); the cut is the same output length on both axes.
      const cx = Math.min(crop.width / 3, radius / project.width), cy = Math.min(crop.height / 3, radius / project.height);
      mask.path = [{ id: "chamfer-0", x: clamp(crop.x + cx), y: clamp(crop.y) }, { id: "chamfer-1", x: clamp(crop.x + crop.width), y: clamp(crop.y) },
        { id: "chamfer-2", x: clamp(crop.x + crop.width), y: clamp(crop.y + crop.height - cy) }, { id: "chamfer-3", x: clamp(crop.x + crop.width - cx), y: clamp(crop.y + crop.height) },
        { id: "chamfer-4", x: clamp(crop.x), y: clamp(crop.y + crop.height) }, { id: "chamfer-5", x: clamp(crop.x), y: clamp(crop.y + cy) }];
    } else {
      const corners = [[crop.x + crop.width - rx, crop.y + ry, -90], [crop.x + crop.width - rx, crop.y + crop.height - ry, 0],
        [crop.x + rx, crop.y + crop.height - ry, 90], [crop.x + rx, crop.y + ry, 180]];
      mask.path = corners.flatMap(([cx, cy, angle], corner) => Array.from({ length: 5 }, (_, step) => {
        const theta = (angle + step * 90 / 4) * Math.PI / 180;
        return { id: `corner-${corner}-${step}`, x: clamp(cx + rx * Math.cos(theta)), y: clamp(cy + ry * Math.sin(theta)) };
      }));
    }
    commands.push({ type: "add_clip_mask", clipId: clip.id, mask });
    mediaBindings.push({ clipId: clip.id, assetId: asset.id, sourceStart: slot.sourceStart, role, layout });
    return { clip, layout };
  }
  function placeSoftComparison(index: number, role: string) {
    const slot = sources[index], prepared = softComparison![index], semanticRole = `source:${index}`;
    let clip = original!;
    if (index > 0) {
      const trackId = roleId(`${semanticRole}:track`, "track", "motion-source-track");
      clip = { ...structuredClone(original!), id: roleId(`${semanticRole}:clip`, "clip", "motion-source-clip", trackId), trackId,
        assetId: slot.assetId, sourceStart: slot.sourceStart, volume: 0, floatingFrame: structuredClone(prepared.floatingFrame),
        keyframes: [], transform: { ...DEFAULT_TRANSFORM }, layer: { enabled: true, blendMode: "normal", role: "content" } };
      commands.push({ type: "add_track", track: { id: trackId, name: role, kind: "video", locked: false, muted: false, clips: [] } },
        { type: "add_clip", clip });
    } else {
      roleId(`${semanticRole}:clip`, "clip", "motion-source-clip", original!.trackId, original!.id);
      commands.push({ type: "set_clip_floating_frame", clipId: original!.id, frame: structuredClone(prepared.floatingFrame) });
    }
    floatingMediaBindings.push({ clipId: clip.id, assetId: slot.assetId, sourceStart: slot.sourceStart, role,
      floatingFrame: prepared.floatingFrame, layout: prepared.layout });
    return { clip };
  }
  const phase = (role: typeof phases[number]["role"], start: number, end: number) => phases.push({ role, startFrame: input.startFrame + start, endFrame: input.startFrame + end });
  const NARRATIVE_BEAT_ROLES = new Set(["promise", "build", "proof", "reveal", "payoff"]), DESIGN_BEAT_ROLES = new Set(["first_frame", "proof", "process", "comparison", "payoff"]);
  function declareBeat(spec: DesignBeat) {
    if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(spec.id) || beatSpecs.some(beat => beat.id === spec.id)) throw new Error(`Template beat ${spec.id} is invalid or declared twice`);
    if (!NARRATIVE_BEAT_ROLES.has(spec.narrativeRole) || !DESIGN_BEAT_ROLES.has(spec.designRole) || !Number.isInteger(spec.startFrame)) {
      throw new Error(`Template beat ${spec.id} needs a narrative role, a design role and an integer start frame`);
    }
    beatSpecs.push({ ...spec }); currentBeat = spec.id;
  }
  function drawInBeat<T>(id: string, draw: () => T): T {
    if (!beatSpecs.some(beat => beat.id === id)) throw new Error(`Template beat ${id} is not declared before it is drawn into`);
    const open = currentBeat;
    currentBeat = id;
    try { return draw(); } finally { currentBeat = open; }
  }
  /** Beats in project frames once the cadence has settled every phase; an empty list means the family declares none yet. */
  function emittedBeats(declaredPhaseStarts: readonly number[]): ReferenceMotionTemplateBeat[] {
    if (!beatSpecs.length) return [];
    const starts = beatSpecs.map(spec => {
      const declared = input.startFrame + spec.startFrame;
      if (!spec.atHold) return declared;
      const hold = phases.findIndex((current, index) => current.role === "hold" && declaredPhaseStarts[index] === declared);
      if (hold < 0) throw new Error(`Template beat ${spec.id} opens with a hold that was never declared at frame ${spec.startFrame}`);
      return phases[hold].startFrame;
    });
    return beatSpecs.map((spec, index) => ({ id: spec.id, narrativeRole: spec.narrativeRole, designRole: spec.designRole, startFrame: starts[index],
      endFrame: starts[index + 1] ?? input.startFrame + input.durationFrames,
      roleKeys: roles.filter(role => (beatOfRoleKey.get(role.key) ?? beatSpecs[0].id) === spec.id).map(role => role.key) }));
  }
  // Role weights resolve to the bundled physical face, so a single-weight family (e.g. a Bold-only brand face) is
  // recorded as the weight it actually renders instead of a substituted heavier request.
  const physicalWeight = (family: string, weight: number) => resolveBundledFontFace(family, weight)?.fontWeight ?? weight;
  // Where a layout box's first physical ink lands below its top for this exact copy, face, size, weight and tracking.
  // Placing lines by measured ink keeps one exact ink column and ink-to-ink rhythm for every bundled face; estimated
  // (non-physical) layouts keep the bundled-CJK .56em approximation.
  function firstInkOffset(presetId: string, text: string, placed: Overrides): number {
    if (!options) return .56 * (placed.fontSize ?? 0);
    const preset = findMotionGraphicPreset(presetId);
    const probe: MotionGraphic = { ...createMotionGraphic("reference-motion-ink-probe", preset.seed.kind ?? "card", text, 0, 1, undefined, preset.seed),
      ...structuredClone({ backgroundColor: transparent, accentColor: transparent, outlineWidth: 0, shadowDepth: 0, fontFamily: style.typography.headingFamily,
        textColor: style.palette.text, letterSpacing: 0, fontWeight: 700, motionV2: motion(),
        layoutV2: { safeArea, maxLines: 2, minFontSize: Math.max(8, 36 * unit), lineGap: 8 * unit, align: "left" as const }, ...placed }) };
    const layout = options.layoutForGraphic(probe);
    const tops = layout.segments.filter(segment => segment.outline?.ink).map(segment => segment.y + segment.outline!.ink!.yMin);
    if (!tops.length) throw new Error("實拍文字需要真正的實體字形邊界");
    return Math.min(...tops) - layout.box.y;
  }

  // Shared on-footage editorial typesetting (explicit source_editorial_v1 only): one left ink column in the observed
  // quiet region, white-first ink with a soft shadow halo, ink-to-ink rhythm and a clean tail; the source is untouched.
  function editorialKit(override?: NormalizedRect) {
    const contract = REFERENCE_MOTION_EDITORIAL_CONTRACT, anchor = contract.textRegion.defaultAnchor;
    const region = override ?? input.textRegion ?? { x: anchor.x, y: portrait ? anchor.yPortrait : anchor.yLandscape, width: anchor.width, height: undefined };
    const ink = contrast(style.palette.text, "#000000") >= contrast(style.palette.surface, "#000000") ? style.palette.text : style.palette.surface;
    if (contrast(ink, "#000000") < 12) throw new Error("實拍上的白字優先標題需要淺色品牌字色（palette text 或 surface）");
    if (Math.max(contrast(style.palette.accent, ink), contrast(style.palette.accent, "#000000")) < 4.5) throw new Error("強調色在白字與暗部實拍上都不夠清楚；請調整 accent");
    type Role = keyof typeof contract.roles;
    type Motion = NonNullable<MotionGraphic["motionV2"]>;
    const px = (size: number) => Math.max(8, size * unit);
    const column = region.x * project.width, columnWidth = region.width * project.width;
    const pad = (size: number) => Math.max(6, Math.ceil(size * .28));
    const inkOf = (graphic: MotionGraphic) => {
      const segments = layouts.find(r => r.graphicId === graphic.id)!.segments.filter(segment => segment.outline?.ink);
      if (!segments.length) throw new Error("實拍文字需要真正的實體字形邊界");
      return { left: Math.min(...segments.map(s => s.x + s.outline!.ink!.xMin)), right: Math.max(...segments.map(s => s.x + s.outline!.ink!.xMax)),
        top: Math.min(...segments.map(s => s.y + s.outline!.ink!.yMin)), bottom: Math.max(...segments.map(s => s.y + s.outline!.ink!.yMax)) };
    };
    const kinetic = (name: "swipe" | "rise" | "focus" | "slam" | "drop", energy: "standard" | "punchy" | "hype", text: string): Motion => {
      const value = kineticTextMotion(name, { fps, unit, energy, text, animationSpeed: input.style?.animationSpeed ?? 1 });
      // The shared left column stays locked: no hold breathing about a centre.
      const { holdScale: _breathing, ...sequence } = value.sequence;
      return { ...value, sequence };
    };
    const unitsOf = (text: string, value: Motion) => value.sequence.unit === "all" ? 1 : motionGraphicV2UnitCount({ text, motionV2: { sequence: { unit: value.sequence.unit } } });
    const entranceSpan = (text: string, value: Motion) => value.entrance.durationFrames + (unitsOf(text, value) - 1) * value.sequence.staggerFrames;
    const exitSpan = (text: string, value: Motion) => value.exit.durationFrames + (unitsOf(text, value) - 1) * motionGraphicV2ExitStaggerFrames(value);
    const need = (text: string | undefined, start: number, value?: Motion) => text && value ? start + entranceSpan(text, value) + readingFrames(text) + exitSpan(text, value) : 0;
    const cleanEnd = (required: number) => {
      if (required > input.durationFrames) throw new Error("實拍文字缺少完整閱讀停留；延長片段或縮短文字");
      // Hold for reading plus a re-read margin, then hand the shot back to the footage; never shorten reading.
      const latest = input.durationFrames - Math.min(Math.round(contract.cleanTailSeconds * fps), input.durationFrames - required);
      return Math.max(required, Math.min(latest, required + Math.round(contract.readingMarginSeconds * fps)));
    };
    const line = (role: string, text: string, kind: Role, motionV2: Motion, start: number, end: number, inkTop: number, maxLines = 1, indent = 0) => {
      const spec = contract.roles[kind], size = px(spec.size), alpha = "alpha" in spec ? spec.alpha : "";
      const family = spec.voice === "heading" ? style.typography.headingFamily : style.typography.bodyFamily;
      const placed: Overrides = { x: (column + indent - pad(size)) / project.width, width: (columnWidth - indent + 2 * pad(size)) / project.width,
        fontSize: size, fontWeight: physicalWeight(family, spec.weight), letterSpacing: spec.tracking * unit, fontFamily: family,
        layoutV2: { safeArea, maxLines, minFontSize: Math.max(8, Math.floor(size)), lineGap: 8 * unit, align: "left" } };
      return add(role, "reel_spatial_headline", text, { ...placed, y: (inkTop - firstInkOffset("reel_spatial_headline", text, placed)) / project.height,
        textColor: `${ink}${alpha}`, shadowDepth: contract.shadow.offsetPixels1080 * unit, shadowBlurPixels: Math.round(contract.shadow.haloEm * size * 10) / 10,
        accentColor: contract.shadow.colour, outlineWidth: 0, motionV2 }, start, end);
    };
    const below = (graphic: MotionGraphic, gap: keyof typeof contract.gapEm) => inkOf(graphic).bottom + contract.gapEm[gap] * graphic.fontSize;
    const verify = (graphics: Array<MotionGraphic | undefined>, avoid?: NormalizedRect) => {
      for (const graphic of graphics) {
        if (!graphic) continue;
        const box = layouts.find(r => r.graphicId === graphic.id)!.box, glyphs = inkOf(graphic);
        if (Math.abs(box.x - graphic.x * project.width) > .000001 || Math.abs(box.y - graphic.y * project.height) > .000001) {
          throw new Error("實拍文字無法維持原訂閱讀錨點；請縮短文案，不可自動移動或縮小文字");
        }
        if (glyphs.left < 0 || glyphs.top < 0 || glyphs.right > project.width || glyphs.bottom > project.height) throw new Error("實拍文字超出畫面");
        if (glyphs.right > column + columnWidth + 1) throw new Error("實拍文字超出觀察到的留白寬度");
        if (region.height !== undefined && (glyphs.top < region.y * project.height - 1 || glyphs.bottom > (region.y + region.height) * project.height + 1)) {
          throw new Error("文字超出觀察到的實拍留白範圍；請縮短文案或提供較大的留白區");
        }
        if (avoid && glyphs.right > avoid.x * project.width && glyphs.left < (avoid.x + avoid.width) * project.width
          && glyphs.bottom > avoid.y * project.height && glyphs.top < (avoid.y + avoid.height) * project.height) {
          throw new Error("實拍文字會蓋到已觀察的主體範圍；請選擇不重疊主體的留白區");
        }
      }
    };
    return { contract, region, ink, px, column, inkOf, kinetic, entranceSpan, exitSpan, need, cleanEnd, line, below, verify, top: region.y * project.height };
  }

  // ---- Design systems (Hao 2026-10-07: Swiss Blue, his own poster theme) ---------------------------------------
  // Shared physical-glyph and vector seams for referenceMotionSwissDesign.ts. Every element is an editable v2 vector,
  // physical-glyph line or clip keyframe; colours come from the editable palette.
  const W = project.width, H = project.height, u = (value: number) => value * unit;
  type DesignMotion = NonNullable<MotionGraphic["motionV2"]>;
  /** Complete on its first frame and gone on its last, with no visible entrance or exit. */
  const designStill = (): DesignMotion => ({ ...motion(1, 1, 0), entrance: { ...motion(1, 1, 0).entrance, opacity: 1, offsetYPixels: 0, offsetXPixels: 0, scale: 1 },
    exit: { ...motion(1, 1, 0).exit, opacity: 1, offsetYPixels: 0, offsetXPixels: 0, scale: 1 } });
  /** Rounded-rectangle contour in canvas pixels; counter-clockwise winding cuts a hole under the non-zero rule. */
  function roundedRect(x: number, y: number, w: number, h: number, radius: number, clockwise = true): MotionVectorShapeCommand[] {
    const r = Math.max(0, Math.min(radius, w / 2, h / 2)), k = .5523 * r;
    if (clockwise) return [{ type: "M", x: x + r, y }, { type: "L", x: x + w - r, y },
      { type: "C", x1: x + w - r + k, y1: y, x2: x + w, y2: y + r - k, x: x + w, y: y + r }, { type: "L", x: x + w, y: y + h - r },
      { type: "C", x1: x + w, y1: y + h - r + k, x2: x + w - r + k, y2: y + h, x: x + w - r, y: y + h }, { type: "L", x: x + r, y: y + h },
      { type: "C", x1: x + r - k, y1: y + h, x2: x, y2: y + h - r + k, x, y: y + h - r }, { type: "L", x, y: y + r },
      { type: "C", x1: x, y1: y + r - k, x2: x + r - k, y2: y, x: x + r, y }, { type: "Z" }];
    return [{ type: "M", x: x + r, y }, { type: "C", x1: x + r - k, y1: y, x2: x, y2: y + r - k, x, y: y + r }, { type: "L", x, y: y + h - r },
      { type: "C", x1: x, y1: y + h - r + k, x2: x + r - k, y2: y + h, x: x + r, y: y + h }, { type: "L", x: x + w - r, y: y + h },
      { type: "C", x1: x + w - r + k, y1: y + h, x2: x + w, y2: y + h - r + k, x: x + w, y: y + h - r }, { type: "L", x: x + w, y: y + r },
      { type: "C", x1: x + w, y1: y + r - k, x2: x + w - r + k, y2: y, x: x + w - r, y }, { type: "Z" }];
  }
  function rotateCommands(commands: MotionVectorShapeCommand[], cx: number, cy: number, degrees: number): MotionVectorShapeCommand[] {
    const a = degrees * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
    const p = (x: number, y: number) => ({ x: cx + (x - cx) * cos - (y - cy) * sin, y: cy + (x - cx) * sin + (y - cy) * cos });
    return commands.map(command => {
      if (command.type === "Z") return command;
      if (command.type === "C") { const c1 = p(command.x1, command.y1), c2 = p(command.x2, command.y2), e = p(command.x, command.y);
        return { type: "C", x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x: e.x, y: e.y }; }
      const e = p(command.x, command.y); return { type: command.type, x: e.x, y: e.y };
    });
  }
  /** A filled vector shape from canvas-pixel contours; the layout box is the contours' bounds. */
  function designShape(role: string, commands: MotionVectorShapeCommand[], color: string, layer: "background" | "foreground", start: number, end: number,
    extra: { softness?: number; motionV2?: DesignMotion; revealFrom?: "left" | "right" | "top" | "bottom"; revealFrames?: number; overText?: boolean; underMedia?: boolean } = {}) {
    const xs: number[] = [], ys: number[] = [];
    for (const command of commands) {
      if (command.type === "Z") continue;
      xs.push(command.x); ys.push(command.y);
      if (command.type === "C") { xs.push(command.x1, command.x2); ys.push(command.y1, command.y2); }
    }
    // The layout box stays on the canvas; contours may bleed past it and are clipped at the frame edge.
    const bx = Math.max(0, Math.floor(Math.min(...xs))), by = Math.max(0, Math.floor(Math.min(...ys)));
    const bw = Math.max(16, Math.min(W, Math.ceil(Math.max(...xs))) - bx), bh = Math.max(1, Math.min(H, Math.ceil(Math.max(...ys))) - by);
    const local = commands.map(command => command.type === "Z" ? command : command.type === "C"
      ? { ...command, x1: command.x1 - bx, y1: command.y1 - by, x2: command.x2 - bx, y2: command.y2 - by, x: command.x - bx, y: command.y - by }
      : { ...command, x: command.x - bx, y: command.y - by });
    return add(role, "reel_native_panel", "", { x: bx / W, y: by / H, width: bw / W, fontSize: 8, compositeLayer: layer,
      backgroundColor: color, accentColor: transparent, cornerRadius: 0, outlineWidth: 0, motionV2: extra.motionV2 ?? designStill(),
      layoutV2: { safeArea, maxLines: 1, minFontSize: 8, lineGap: 0, align: "left" },
      vectorV2: { schema: "editkin.motion-vector-shape/v1", kind: "shape", heightPixels: bh, revealFrames: extra.revealFrames ?? 1,
        ...(extra.revealFrom ? { revealFrom: extra.revealFrom } : {}), ...(extra.softness ? { softnessPixels: extra.softness } : {}),
        ...(extra.overText ? { stack: "over_text" as const } : extra.underMedia || layer === "background" ? { stack: "under_media" as const } : {}), commands: local } }, start, end);
  }
  /** Rounded panel or ellipse; background panels use the stage schema so they composite under the footage. */
  function designPanel(role: string, x: number, y: number, w: number, h: number, radius: number, color: string, layer: "background" | "foreground",
    start: number, end: number, extra: { softness?: number; motionV2?: DesignMotion; ellipse?: boolean } = {}) {
    const left = Math.max(0, x), top = Math.max(0, y), right = Math.min(W, x + w), bottom = Math.min(H, y + h);
    return add(role, extra.ellipse ? "reel_native_disc" : "reel_native_panel", "", { x: left / W, y: top / H, width: Math.max(16, right - left) / W, fontSize: 8,
      compositeLayer: layer, backgroundColor: color, accentColor: transparent, cornerRadius: extra.ellipse ? 0 : radius, outlineWidth: 0,
      motionV2: extra.motionV2 ?? designStill(), layoutV2: { safeArea, maxLines: 1, minFontSize: 8, lineGap: 0, align: "left" },
      vectorV2: { schema: layer === "background" ? "editkin.motion-vector-stage/v1" as const : "editkin.motion-vector/v1" as const,
        kind: extra.ellipse ? "ellipse" as const : "panel" as const, heightPixels: Math.max(1, bottom - top), revealFrames: 1,
        ...(extra.softness ? { softnessPixels: extra.softness } : {}) } }, start, end);
  }
  /** Physical-glyph geometry for one block: a column [x, x + width] with the block's first ink on inkTop. */
  function designPlaced(text: string, spec: DesignType, x: number, width: number): Overrides {
    const family = spec.family ?? style.typography.headingFamily, size = u(spec.size), pad = Math.max(6, Math.ceil(size * .28));
    return { x: (x - pad) / W, width: (width + 2 * pad) / W, fontSize: size, fontFamily: family, fontWeight: physicalWeight(family, spec.weight),
      letterSpacing: u(spec.tracking ?? 0), layoutV2: { safeArea, maxLines: spec.maxLines ?? 1, minFontSize: Math.max(8, Math.floor(size)), lineGap: u(10), align: spec.align ?? "left" } };
  }
  function designProbe(text: string, at: Overrides, color: string) {
    const preset = findMotionGraphicPreset("reel_spatial_headline");
    const graphic: MotionGraphic = { ...createMotionGraphic("reference-motion-design-probe", preset.seed.kind ?? "card", text, 0, 1, undefined, preset.seed),
      ...structuredClone({ backgroundColor: transparent, accentColor: transparent, outlineWidth: 0, shadowDepth: 0, textColor: color,
        motionV2: { ...motion(), sequence: { ...motion().sequence, unit: "character" as const } }, ...at }) };
    return options!.layoutForGraphic(graphic);
  }
  const inkSegments = (segments: MotionGraphicV2LayoutReceipt["segments"]) => {
    const inked = segments.filter(segment => segment.outline?.ink);
    if (!inked.length) throw new Error("設計文字需要真正的實體字形邊界");
    return inked;
  };
  const boundsOf = (segments: MotionGraphicV2LayoutReceipt["segments"]) => ({
    left: Math.min(...segments.map(s => s.x + s.outline!.ink!.xMin)), right: Math.max(...segments.map(s => s.x + s.outline!.ink!.xMax)),
    top: Math.min(...segments.map(s => s.y + s.outline!.ink!.yMin)), bottom: Math.max(...segments.map(s => s.y + s.outline!.ink!.yMax)) });
  /** A canvas-pixel window as the frame-fraction clipRegion (mask reveals, rolling digits); clamped to the frame. */
  function designClip(rect: { x: number; y: number; w: number; h: number }) {
    const x0 = Math.max(0, rect.x), y0 = Math.max(0, rect.y), x1 = Math.min(W, rect.x + rect.w), y1 = Math.min(H, rect.y + rect.h);
    if (x1 - x0 < 1 || y1 - y0 < 1) throw new Error("遮罩視窗不在畫面內");
    return { x: x0 / W, y: y0 / H, width: (x1 - x0) / W, height: (y1 - y0) / H };
  }
  function designLine(role: string, text: string, spec: DesignType, x: number, width: number, inkTop: number, motionV2: DesignMotion, start: number, end: number,
    extra: { clip?: { x: number; y: number; w: number; h: number }; flash?: boolean } = {}) {
    const placed = designPlaced(text, spec, x, width);
    return add(role, "reel_spatial_headline", text, { ...placed, y: (inkTop - firstInkOffset("reel_spatial_headline", text, placed)) / H,
      textColor: spec.color, outlineWidth: 0, shadowDepth: 0, motionV2, ...(extra.clip ? { clipRegion: designClip(extra.clip) } : {}) }, start, end, extra.flash);
  }
  /** Count-up: the number climbs from `from` (zero by default; a previous year rolls forward) in short flash steps (two
   * frames each, decelerating), keeping its prefix, suffix, decimals and separators, then the final text holds. */
  function designCount(role: string, text: string, spec: DesignType, x: number, width: number, inkTop: number, motionV2: DesignMotion, start: number, end: number,
    steps = 9, from = 0): MotionGraphic[] {
    const match = text.match(/^(\D*?)(\d[\d,]*(?:\.\d+)?)(.*)$/s);
    if (!match || steps < 2) return [designLine(role, text, spec, x, width, inkTop, motionV2, start, end)];
    const [, prefix, number, suffix] = match, decimals = number.includes(".") ? number.split(".")[1].length : 0, grouped = number.includes(",");
    const target = Number(number.replaceAll(",", ""));
    const format = (value: number) => {
      const [whole, fraction] = value.toFixed(decimals).split(".");
      return `${prefix}${grouped ? Number(whole).toLocaleString("en-US") : whole}${fraction ? `.${fraction}` : ""}${suffix}`;
    };
    const hold = 2, graphics: MotionGraphic[] = [];
    let at = start, last = "";
    for (let step = 0; step < steps; step++) {
      const value = format(from + (target - from) * (1 - (1 - step / steps) ** 3));
      if (value === last || value === text) continue;
      graphics.push(designLine(`${role}:count:${step}`, value, spec, x, width, inkTop, designStill(), at, at + hold, { flash: true }));
      at += hold; last = value;
    }
    graphics.push(designLine(role, text, spec, x, width, inkTop, motionV2, at, end));
    return graphics;
  }
  /** A self-drawing centerline (canvas pixels): donut arcs, chart lines, underlines, routes; the box is its padded bounds. */
  function designStroke(role: string, commands: MotionVectorShapeCommand[], color: string, start: number, end: number,
    extra: { width: number; revealFrames: number; from?: number; to?: number; tip?: number; tipColor?: string; cap?: "round" | "butt";
      overText?: boolean; underMedia?: boolean; softness?: number; motionV2?: DesignMotion }) {
    const xs: number[] = [], ys: number[] = [];
    for (const command of commands) {
      if (command.type === "Z") continue;
      xs.push(command.x); ys.push(command.y);
      if (command.type === "C") { xs.push(command.x1, command.x2); ys.push(command.y1, command.y2); }
    }
    const pad = Math.ceil(extra.width / 2 + (extra.tip ?? 0) + 2);
    const bx = Math.max(0, Math.floor(Math.min(...xs) - pad)), by = Math.max(0, Math.floor(Math.min(...ys) - pad));
    const bw = Math.max(16, Math.min(W, Math.ceil(Math.max(...xs) + pad)) - bx), bh = Math.max(1, Math.min(H, Math.ceil(Math.max(...ys) + pad)) - by);
    const local = commands.map(command => command.type === "Z" ? command : command.type === "C"
      ? { ...command, x1: command.x1 - bx, y1: command.y1 - by, x2: command.x2 - bx, y2: command.y2 - by, x: command.x - bx, y: command.y - by }
      : { ...command, x: command.x - bx, y: command.y - by });
    return add(role, "reel_native_panel", "", { x: bx / W, y: by / H, width: bw / W, fontSize: 8, compositeLayer: extra.underMedia ? "background" : "foreground",
      backgroundColor: color, accentColor: extra.tipColor ?? color, cornerRadius: 0, outlineWidth: 0, motionV2: extra.motionV2 ?? designStill(),
      layoutV2: { safeArea, maxLines: 1, minFontSize: 8, lineGap: 0, align: "left" },
      vectorV2: { schema: "editkin.motion-vector-stroke/v1", kind: "stroke", heightPixels: bh, revealFrames: Math.max(1, Math.round(extra.revealFrames)), commands: local,
        widthPixels: extra.width, ...(extra.cap ? { cap: extra.cap } : {}), ...(extra.from !== undefined ? { from: extra.from } : {}), ...(extra.to !== undefined ? { to: extra.to } : {}),
        ...(extra.tip ? { tipRadiusPixels: extra.tip } : {}), ...(extra.softness ? { softnessPixels: extra.softness } : {}),
        ...(extra.overText ? { stack: "over_text" as const } : extra.underMedia ? { stack: "under_media" as const } : {}) } }, start, end);
  }
  function designMeasure(text: string, spec: DesignType, x: number, width: number) {
    const bounds = boundsOf(inkSegments(designProbe(text, { ...designPlaced(text, spec, x, width), y: 0 }, spec.color).segments));
    return { left: bounds.left, right: bounds.right, height: bounds.bottom - bounds.top };
  }
  /** Visible glyphs per visual line for a block laid out at [x, x + width] (wrapping as the engine wraps it). */
  function designMeasureLines(text: string, spec: DesignType, x: number, width: number) {
    const segments = inkSegments(designProbe(text, { ...designPlaced(text, spec, x, width), y: 0 }, spec.color).segments), tops: number[] = [], counts: number[] = [];
    for (const segment of [...segments].sort((a, b) => a.y - b.y)) {
      const at = tops.findIndex(top => Math.abs(top - segment.y) < u(spec.size) * .5);
      if (at < 0) { tops.push(segment.y); counts.push(1); } else counts[at]++;
    }
    return counts;
  }
  const designInk = (graphic: MotionGraphic) => boundsOf(inkSegments(layouts.find(r => r.graphicId === graphic.id)!.segments));
  /** Ink bounds per visual line, top to bottom. */
  function designInkLines(graphic: MotionGraphic) {
    const segments = inkSegments(layouts.find(r => r.graphicId === graphic.id)!.segments), lines: Array<typeof segments> = [];
    for (const segment of [...segments].sort((a, b) => a.y - b.y)) {
      const line = lines.find(row => Math.abs(row[0].y - segment.y) < graphic.fontSize * .5);
      if (line) line.push(segment); else lines.push([segment]);
    }
    return lines.map(boundsOf);
  }
  /** One block in several colours. The whole text is laid out once (wrapping included); every colour run is then set,
   * line by line, on that layout's exact glyph positions, and the per-character cascade continues across the pieces. */
  function designInline(role: string, runs: Array<{ text: string; color: string }>, spec: DesignType, x: number, width: number, inkTop: number,
    motionFor: (text: string) => DesignMotion, start: number, end: number,
    extra: { clipLines?: { padX: number; padTop: number; padBottom: number }; runStarts?: number[]; heldFrom?: number } = {}): MotionGraphic[] {
    const whole = runs.map(run => run.text).join("");
    // A mask reveal sets every visual line in its own window, so even a single colour run is split by line.
    if (runs.length === 1 && !extra.clipLines) return [designLine(role, whole, { ...spec, color: runs[0].color }, x, width, inkTop, motionFor(whole), extra.runStarts?.[0] ?? start, end)];
    const wholeMotion = motionFor(whole), placed = designPlaced(whole, spec, x, width);
    const y = (inkTop - firstInkOffset("reel_spatial_headline", whole, placed)) / H;
    const glyphs = designProbe(whole, { ...placed, y }, spec.color).segments, chars = [...whole];
    const visible = chars.map((char, index) => ({ char, index })).filter(entry => entry.char.trim());
    if (glyphs.length !== visible.length) return [designLine(role, whole, spec, x, width, inkTop, wholeMotion, start, end)]; // shaping merged glyphs
    const runOf = runs.flatMap((run, index) => [...run.text].map(() => index));
    const lineTops: number[] = [];
    const lineOf = (segmentY: number) => {
      let at = lineTops.findIndex(top => Math.abs(top - segmentY) < u(spec.size) * .5);
      if (at < 0) { lineTops.push(segmentY); at = lineTops.length - 1; }
      return at;
    };
    const pieces: Array<{ run: number; line: number; first: number; last: number }> = [];
    visible.forEach((entry, v) => {
      const run = runOf[entry.index], line = lineOf(glyphs[v].y), previous = pieces.at(-1);
      if (previous && previous.run === run && previous.line === line) previous.last = v; else pieces.push({ run, line, first: v, last: v });
    });
    const stagger = wholeMotion.sequence.unit === "all" ? 0 : wholeMotion.sequence.staggerFrames;
    const single: Overrides = { ...placed, layoutV2: { ...placed.layoutV2!, maxLines: 1, align: "left" } };
    const pad = extra.clipLines, lineWindow = (line: number) => {
      const box = boundsOf(visible.map((_, v) => glyphs[v]).filter(segment => lineOf(segment.y) === line && segment.outline?.ink));
      return designClip({ x: box.left - pad!.padX, y: box.top - pad!.padTop, w: box.right - box.left + 2 * pad!.padX, h: box.bottom - box.top + pad!.padTop + pad!.padBottom });
    };
    return pieces.map((piece, index) => {
      const text = chars.slice(visible[piece.first].index, visible[piece.last].index + 1).join("");
      const target = glyphs[piece.first], own = designProbe(text, { ...single, y }, spec.color).segments[0];
      const pieceX = single.x! + (target.x - own.x) / W, pieceY = y + (target.y - own.y) / H;
      // Word builds give every run its own start and its own motion; otherwise the line keeps one continuous stagger.
      const runStart = extra.runStarts?.[piece.run], motionV2 = runStart === undefined ? wholeMotion : motionFor(text), pieceStart = runStart ?? start + piece.first * stagger;
      const at: Overrides = { ...single, x: pieceX, width: Math.max(16 / W, Math.min(placed.width!, 1 - pieceX)), y: pieceY,
        textColor: runs[piece.run].color, outlineWidth: 0, shadowDepth: 0, ...(pad ? { clipRegion: lineWindow(piece.line) } : {}) };
      const graphic = add(`${role}:${index}`, "reel_spatial_headline", text, { ...at, motionV2 }, pieceStart, end);
      // Held from `heldFrom`: until its turn in the cascade a later piece shows exactly its first entrance pose (a still copy
      // moved by the entrance offset), so the whole block is on screen from that frame and still lands in reading order.
      if (extra.heldFrom !== undefined && pieceStart > extra.heldFrom) {
        const first = motionV2.entrance;
        if (first.opacity !== 1 || first.scale !== 1 || first.rotationDegrees || first.blurPixels || first.spreadPixels) throw new Error("逐字接續的等待姿態只支援完整可見的純位移進場");
        const still = designStill(), rest = motionV2.sequence.restRotationDegrees;
        add(`${role}:${index}:lead`, "reel_spatial_headline", text, { ...at, x: pieceX + first.offsetXPixels / W, y: pieceY + first.offsetYPixels / H,
          motionV2: rest ? { ...still, sequence: { ...still.sequence, restRotationDegrees: rest } } : still }, extra.heldFrom, pieceStart, true);
      }
      return graphic;
    });
  }

  if (input.designSystem !== undefined) {
    if (!options) throw new Error("設計系統需要 generation 2 實體字形版面");
    compileDesignThemeScene(graphicPosterContextV3(graphicCopyFitContextV3({ project, input, fps, portrait, unit, sources, sourceAssets, original, mainAsset,
      readingFrames, add, place, animate, phase, beat: declareBeat, withBeat: drawInBeat, push: command => { commands.push(command); },
      line: designLine, count: designCount, stroke: designStroke, inline: designInline, measure: designMeasure, measureLines: designMeasureLines, ink: designInk, inkLines: designInkLines,
      panel: designPanel, shape: designShape, still: designStill, roundedRect, rotateCommands,
      sourceLayout: (asset, region) => motionSourceLayout(project, asset, region) }, options), options));
  } else if (input.templateId === "kinetic_network") {
    // An original abstract explanation with three explicit semantic states.
    // Point geometry is shared SVG/libass, not a video backdrop or HTML animation.
    const items = input.items!, fieldMove = move;
    const stageFrames = items.map((item, index) => Math.max(readingFrames(item.label), readingFrames(item.detail ?? ""))
      + Math.max(fieldMove, entrance) + exit
      + (brisk && ((index === 1 && input.network?.labels) || (index === 2 && input.network?.hubLabel)) ? entrance : 0));
    const needed = stageFrames.reduce((a, b) => a + b, 0);
    if (needed > input.durationFrames) throw new Error("三幕動態與短語缺少閱讀停留；延長片段或縮短說明");
    const spare = input.durationFrames - needed;
    const lengths = stageFrames.map((length, index) => length + Math.floor(spare / 3) + (index < spare % 3 ? 1 : 0));
    const boundaries = [0, lengths[0], lengths[0] + lengths[1], input.durationFrames];
    panel("stage", { x: 0, y: 0, width: 1, height: 1 });
    if (input.kicker) text("kicker", input.kicker, .07, .035, .86, 30, 0, input.durationFrames, style.palette.muted, 1);
    text("headline", input.title, .075, portrait ? .79 : .8, .85, 54, 0, input.durationFrames, style.palette.text, 2);
    const field = { x: .065, y: portrait ? .34 : .385, width: .87, height: portrait ? .4 : .365 };
    const groupColors: [string, string, string] = input.network?.groupColors ?? (input.style ? [style.palette.accent, style.palette.muted, style.palette.separator] : DEFAULT_REFERENCE_NETWORK_COLORS);
    // Translucent capability areas appear when the points settle. Color marks
    // meaning, rather than decorating every word with a different hue.
    if (input.network?.labels) CONNECTION_FIELD_GROUP_CENTERS.forEach((center, index) => {
      const radius = [.15, .14, .16][index];
      add(`network:area:${index}`, "reel_native_disc", "", { x: field.x + field.width * (center.x - radius), y: field.y + field.height * (center.y - radius),
        width: field.width * radius * 2, fontSize: 8, backgroundColor: `${groupColors[index]}22`,
        layoutV2: { safeArea, maxLines: 1, minFontSize: 8, lineGap: 0, align: "left" },
        vectorV2: { schema: "editkin.motion-vector/v1", kind: "ellipse", heightPixels: field.height * radius * 2 * project.height, revealFrames: 1 } },
      boundaries[1] + fieldMove, input.durationFrames);
    });
    add("network:field", "reel_connection_field", "", { x: field.x, y: field.y, width: field.width, fontSize: 8,
      textColor: `${style.palette.muted}B0`, accentColor: style.palette.accent, backgroundColor: `${style.palette.muted}50`,
      layoutV2: { safeArea, maxLines: 1, minFontSize: 8, lineGap: 0, align: "left" },
      motionV2: { ...motion(1, 1, 0), entrance: { ...motion().entrance, durationFrames: 1, opacity: 1, offsetYPixels: 0 }, exit: { ...motion().exit, durationFrames: 1, opacity: 1 } },
      vectorV2: { schema: "editkin.motion-vector/v1", kind: "connection_field", heightPixels: project.height * field.height, revealFrames: 1,
        seed: input.network?.seed ?? 32021, points: input.network?.points ?? 32, dotRadiusPixels: Math.min(12, Math.max(1, 9 * unit)), lineWidthPixels: Math.min(8, Math.max(.5, 3 * unit)),
        burstFrames: fieldMove, gatherStartFrame: boundaries[1], gatherFrames: fieldMove,
        connectStartFrame: boundaries[2], connectFrames: fieldMove,
        groupColors } });
    const nodeLabel = (role: string, value: string, x: number, y: number, start: number) => add(role, "reel_spatial_headline", value,
      { x: x - .115, y: y - .024, width: .23, fontSize: 46 * unit, fontFamily: style.typography.bodyFamily,
        textColor: style.palette.text, backgroundColor: style.palette.surface, cornerRadius: 6 * unit,
        layoutV2: { safeArea, maxLines: 1, minFontSize: Math.max(8, 34 * unit), lineGap: 0, align: "center", widthMode: "fit_content" } }, start, input.durationFrames);
    input.network?.labels?.forEach((label, index) => {
      const center = CONNECTION_FIELD_GROUP_CENTERS[index];
      nodeLabel(`network:label:${index}`, label, field.x + field.width * center.x, field.y + field.height * center.y, boundaries[1] + fieldMove);
    });
    if (input.network?.hubLabel) nodeLabel("network:hub", input.network.hubLabel, field.x + field.width * .53, field.y + field.height * .55, boundaries[2] + fieldMove);
    items.forEach((item, index) => {
      const start = boundaries[index], end = boundaries[index + 1];
      const headline = add(`item:${index}:label`, "reel_spatial_headline", item.label, { x: .065, y: portrait ? .12 : .11, width: .87, fontSize: (portrait ? 144 : 112) * unit, fontWeight: 900,
        fontFamily: style.typography.headingFamily, textColor: index === 2 ? style.palette.accent : index === 1 ? style.palette.muted : style.palette.text,
        layoutV2: { safeArea, maxLines: 1, minFontSize: 64 * unit, lineGap: 0, align: "left" },
        motionV2: { ...motion(entrance, exit, 0, 28 * unit),
          entrance: { ...motion().entrance, offsetXPixels: 28 * unit * travel, offsetYPixels: 0, scale: .94 },
          exit: { ...motion().exit, offsetXPixels: -20 * unit * travel, offsetYPixels: 0 } } }, start, end);
      const headlineBox = layouts.find(layout => layout.graphicId === headline.id)!.box;
      if (item.detail) {
        const detailY = Math.max(portrait ? .235 : .30, (headlineBox.y + headlineBox.height + 12 * unit) / project.height);
        const detail = text(`item:${index}:detail`, item.detail, .08, detailY, .84, 46, start, end, style.palette.muted, 1);
        const detailBox = layouts.find(layout => layout.graphicId === detail.id)!.box;
        if (detailBox.y + detailBox.height >= field.y * project.height) throw new Error("字型比例壓縮了點群空間；請調整主標字型或縮短短句");
      }
      phase(index === 0 ? "reveal" : "focus", start, start + fieldMove);
      const labelEntrance = brisk && ((index === 1 && input.network?.labels) || (index === 2 && input.network?.hubLabel)) ? entrance : 0;
      phase("hold", start + Math.max(fieldMove, entrance) + labelEntrance, end - exit);
    });
  } else if (input.overlayPresentation === "source_editorial_v1") {
    // The live source stays full-bleed: no clip layout, mask, window or backing. Only text and thin accent marks.
    const k = editorialKit(), c = k.contract;
    if (input.templateId === "level_bridge") {
      const kickerMotion = input.kicker ? k.kinetic(c.motion.kicker, "standard", input.kicker) : undefined;
      const titleMotion = k.kinetic(c.motion.title, "punchy", input.title);
      const subtitleMotion = input.subtitle ? k.kinetic(c.motion.support, "standard", input.subtitle) : undefined;
      const titleStart = input.kicker ? cadence.shortDelayFrames : 0;
      const subtitleStart = titleStart + Math.max(1, k.entranceSpan(input.title, titleMotion) - Math.round(.1 * fps));
      const end = k.cleanEnd(Math.max(k.need(input.kicker, 0, kickerMotion), k.need(input.title, titleStart, titleMotion), k.need(input.subtitle, subtitleStart, subtitleMotion)));
      const kicker = input.kicker ? k.line("kicker", input.kicker, "kicker", kickerMotion!, 0, end, k.top) : undefined;
      const title = k.line("headline", input.title, "title", titleMotion, titleStart, end, kicker ? k.below(kicker, "kicker") : k.top, 2);
      const subtitle = input.subtitle ? k.line("subtitle", input.subtitle, "subtitle", subtitleMotion!, subtitleStart, end, k.below(title, "subtitle"), 2) : undefined;
      k.verify([kicker, title, subtitle]);
      const settled = Math.max(titleStart + k.entranceSpan(input.title, titleMotion), subtitle ? subtitleStart + k.entranceSpan(input.subtitle!, subtitleMotion!) : 0);
      phase("reveal", 0, settled); phase("hold", settled, end - exit);
    } else if (input.templateId === "context_stack") {
      const items = input.items!, indent = c.connector.indentPixels1080 * unit;
      const titleMotion = k.kinetic(c.motion.title, "punchy", input.title);
      const step = Math.max(cadence.itemStepFrames, Math.round(.5 * fps));
      const firstItem = Math.max(1, k.entranceSpan(input.title, titleMotion) - Math.round(.1 * fps));
      const itemStart = (index: number) => firstItem + index * step;
      const labelMotions = items.map(item => k.kinetic(c.motion.item, "standard", item.label));
      const detailMotions = items.map(item => item.detail ? k.kinetic(c.motion.support, "standard", item.detail) : undefined);
      const end = k.cleanEnd(Math.max(k.need(input.title, 0, titleMotion), ...items.flatMap((item, index) => [
        k.need(item.label, itemStart(index), labelMotions[index]), k.need(item.detail, itemStart(index) + cadence.shortDelayFrames, detailMotions[index])])));
      const title = k.line("headline", input.title, "stackTitle", titleMotion, 0, end, k.top);
      let cursor = k.below(title, "item");
      const rows = items.map((item, index) => {
        const label = k.line(`item:${index}:label`, item.label, "itemLabel", labelMotions[index], itemStart(index), end, cursor, 1, indent);
        const detail = item.detail ? k.line(`item:${index}:detail`, item.detail, "itemDetail", detailMotions[index]!, itemStart(index) + cadence.shortDelayFrames, end, k.below(label, "detail"), 1, indent) : undefined;
        cursor = k.below(detail ?? label, "item");
        return { label, detail };
      });
      k.verify([title, ...rows.flatMap(row => [row.label, row.detail])]);
      // A causal thread grows down the column as each step arrives, with one node per step. Accent only; no numbers.
      const lineWidth = Math.max(1, c.connector.widthPixels1080 * unit), node = Math.max(16, c.connector.nodePixels1080 * unit);
      // Thread centred in the gutter between the title column and the indented steps. The layout box keeps the
      // engine's 16px minimum; the stroke itself is drawn centred inside it.
      const threadBox = Math.max(16, lineWidth), threadX = k.column + indent * .3 - threadBox / 2, stroke = (threadBox - lineWidth) / 2;
      const top = k.inkOf(rows[0].label).top, bottom = k.inkOf(rows.at(-1)!.detail ?? rows.at(-1)!.label).bottom;
      const still = { ...motion(1, exit, 0), entrance: { ...motion(1, exit, 0).entrance, opacity: 1 } };
      add("thread", "reel_native_panel", "", { x: threadX / project.width, y: top / project.height, width: threadBox / project.width, fontSize: 8,
        backgroundColor: style.palette.accent, accentColor: transparent, cornerRadius: 0, motionV2: still,
        layoutV2: { safeArea, maxLines: 1, minFontSize: 8, lineGap: 0, align: "left" },
        vectorV2: { schema: "editkin.motion-vector-shape/v1", kind: "shape", heightPixels: bottom - top, revealFrom: "top",
          revealFrames: Math.max(2, itemStart(items.length - 1) - itemStart(0) + entrance),
          commands: [{ type: "M", x: stroke, y: 0 }, { type: "L", x: stroke + lineWidth, y: 0 }, { type: "L", x: stroke + lineWidth, y: bottom - top }, { type: "L", x: stroke, y: bottom - top }, { type: "Z" }] } },
        itemStart(0), end);
      rows.forEach((row, index) => {
        const ink = k.inkOf(row.label), centreY = (ink.top + ink.bottom) / 2;
        add(`item:${index}:node`, "reel_native_disc", "", { x: (threadX + threadBox / 2 - node / 2) / project.width, y: (centreY - node / 2) / project.height,
          width: node / project.width, fontSize: 8, backgroundColor: style.palette.accent, accentColor: transparent, motionV2: motion(entrance, exit, 0),
          layoutV2: { safeArea, maxLines: 1, minFontSize: 8, lineGap: 0, align: "left" },
          vectorV2: { schema: "editkin.motion-vector/v1", kind: "ellipse", heightPixels: node, revealFrames: 1 } }, itemStart(index), end);
      });
      const settled = itemStart(items.length - 1) + Math.max(...rows.map((row, index) => k.entranceSpan(items[index].label, labelMotions[index]))) + cadence.shortDelayFrames;
      phase("reveal", 0, settled); phase("hold", settled, end - exit);
    } else {
      // brand_recap: the live source keeps playing full-bleed; 2-4 short points take turns as the main visual.
      const items = input.items!;
      if (items.some(item => [...item.label].length > 8)) throw new Error("主視覺短語最多 8 字；較長說明放在 detail，不縮成小字清單");
      const kickerMotion = input.kicker ? k.kinetic(c.motion.kicker, "standard", input.kicker) : undefined;
      const titleMotion = k.kinetic(c.motion.support, "standard", input.title);
      const labelMotions = items.map(item => k.kinetic(c.motion.recap, "punchy", item.label));
      const detailMotions = items.map(item => item.detail ? k.kinetic(c.motion.support, "standard", item.detail) : undefined);
      const stageFrames = items.map((item, index) => Math.max(
        k.entranceSpan(item.label, labelMotions[index]) + readingFrames(item.label) + k.exitSpan(item.label, labelMotions[index]),
        item.detail ? cadence.shortDelayFrames + k.entranceSpan(item.detail, detailMotions[index]!) + readingFrames(item.detail) + k.exitSpan(item.detail, detailMotions[index]!) : 0));
      const headerNeed = Math.max(k.need(input.kicker, 0, kickerMotion), k.need(input.title, 0, titleMotion));
      const end = k.cleanEnd(Math.max(headerNeed, stageFrames.reduce((a, b) => a + b, 0)));
      const spare = end - stageFrames.reduce((a, b) => a + b, 0);
      const kicker = input.kicker ? k.line("kicker", input.kicker, "kicker", kickerMotion!, 0, end, k.top) : undefined;
      const title = k.line("headline", input.title, "stackTitle", titleMotion, input.kicker ? cadence.shortDelayFrames : 0, end, kicker ? k.below(kicker, "kicker") : k.top);
      const stageTop = k.below(title, "item");
      let cursor = 0;
      const shown: MotionGraphic[] = [];
      items.forEach((item, index) => {
        const start = cursor, stop = start + stageFrames[index] + Math.floor(spare / items.length) + (index < spare % items.length ? 1 : 0);
        cursor = stop;
        const label = k.line(`item:${index}:label`, item.label, "recapLabel", labelMotions[index], start, stop, stageTop);
        const detail = item.detail ? k.line(`item:${index}:detail`, item.detail, "recapDetail", detailMotions[index]!, start + cadence.shortDelayFrames, stop, k.below(label, "detail")) : undefined;
        shown.push(label, ...(detail ? [detail] : []));
        const settled = start + Math.max(k.entranceSpan(item.label, labelMotions[index]), detail ? cadence.shortDelayFrames + k.entranceSpan(item.detail!, detailMotions[index]!) : 0);
        phase("reveal", start, settled); phase("hold", settled, stop - k.exitSpan(item.label, labelMotions[index]));
      });
      k.verify([kicker, title, ...shown], input.focusRegion);
    }
  } else if (input.windowPresentation === "source_backdrop_v1") {
    // Hao's non-full-frame rule: the primary clip itself becomes the same image, enlarged and softly blurred, behind
    // sharp silent windows, so its audio and clock never change. No stage panel, header box or numbered plates.
    const b = REFERENCE_MOTION_SOURCE_BACKDROP_CONTRACT, bandRegion = b.textBand[portrait ? "portrait" : "landscape"];
    const k = editorialKit(bandRegion), c = k.contract;
    // The primary stays source 0 (now its own backdrop); its sharp clone is source 0's window.
    roleId("source:0:clip", "clip", "motion-source-clip", original!.trackId, original!.id);
    const windowKey = (index: number) => index === 0 ? "source:0:window" : `source:${index}`;
    commands.push({ type: "update_clip_transform", clipId: original!.id, patch: { ...DEFAULT_TRANSFORM, scale: b.backdrop.scale } },
      { type: "set_clip_creative", clipId: original!.id,
        patch: { effectPresetIds: [...new Set([...(original!.creative?.effectPresetIds ?? []), b.backdrop.effectPresetId])] } });
    const kickerMotion = input.kicker ? k.kinetic(c.motion.kicker, "standard", input.kicker) : undefined;
    const titleMotion = k.kinetic(c.motion.title, "punchy", input.title);
    const titleStart = input.kicker ? cadence.shortDelayFrames : 0;
    const bandNeed = Math.max(k.need(input.kicker, 0, kickerMotion), k.need(input.title, titleStart, titleMotion));
    const bandLines = (end: number) => {
      if (bandNeed > end) throw new Error("標題缺少完整閱讀停留；延長片段或縮短標題");
      const kicker = input.kicker ? k.line("kicker", input.kicker, "kicker", kickerMotion!, 0, end, k.top) : undefined;
      const title = k.line("headline", input.title, "bandTitle", titleMotion, titleStart, end, kicker ? k.below(kicker, "kicker") : k.top);
      k.verify([kicker, title]);
      return title;
    };
    // A quiet single line in its own observed column (window label or support line), verified like every other line.
    const quietLine = (role: string, value: string, column: NormalizedRect, start: number, end: number) => {
      const lk = editorialKit(column), motionValue = lk.kinetic(c.motion.support, "standard", value);
      if (lk.need(value, start, motionValue) > end) throw new Error(`「${value}」缺少閱讀停留；延長片段或縮短文字`);
      const graphic = lk.line(role, value, "windowLabel", motionValue, start, end, lk.top);
      lk.verify([graphic]);
      return { graphic, bottom: lk.inkOf(graphic).bottom };
    };
    if (input.templateId === "comparison_pair") {
      // Two rounded, feathered source-ratio windows (no dark passe-partout) over the blurred primary.
      const end = input.durationFrames, labelStart = entrance + cadence.shortDelayFrames;
      bandLines(end);
      let labelsBottom = 0;
      const regions = portrait ? [{ x: .065, y: .29, width: .405, height: .43 }, { x: .53, y: .29, width: .405, height: .43 }]
        : [{ x: .065, y: .29, width: .405, height: .46 }, { x: .53, y: .29, width: .405, height: .46 }];
      regions.forEach((region, index) => {
        const { clip, layout } = place(index, region, index === 0 ? "主要比較素材" : "獨立比較素材", true, undefined, windowKey(index));
        animate(windowKey(index), clip, [{ key: "entrance-start", frame: 0, transform: { x: (index === 0 ? -18 : 18) * unit, opacity: 0 } }, { key: "entrance-settle", frame: entrance }]);
        // Each label sits in its own window's column, just under that window's placed source viewport.
        const view = layout.viewport;
        const label = quietLine(`source:${index}:label`, sources[index].label, { x: view.x, y: view.y + view.height + .012,
          width: view.width, height: .07 }, labelStart, end);
        labelsBottom = Math.max(labelsBottom, label.bottom);
      });
      if (input.subtitle) quietLine("subtitle", input.subtitle, { x: bandRegion.x, y: labelsBottom / project.height + .02, width: bandRegion.width, height: .08 },
        labelStart + cadence.shortDelayFrames, end);
      phase("reveal", 0, entrance); phase("hold", entrance, end - exit);
    } else if (input.templateId === "evidence_takeover") {
      // The title reads completely and leaves before the synced window takes over the frame; after the hand-back the
      // support line states what was just shown.
      const initialHold = Math.max(bandNeed, entrance + exit + Math.max(readingFrames(input.title), readingFrames(input.kicker ?? "")));
      // The hand-back leaves the support line its complete entrance, reading and exit.
      const supportMotion = input.subtitle ? k.kinetic(c.motion.support, "standard", input.subtitle) : undefined;
      const afterReturn = Math.max(cadence.returnHoldFrames, k.need(input.subtitle, 0, supportMotion));
      const focusStart = initialHold + move, returnStart = input.durationFrames - move - afterReturn;
      if (returnStart - focusStart < Math.ceil(fps * 1.2)) throw new Error("接管場景需要至少 1.2 秒全畫面證據停留；延長片段或縮短標題");
      bandLines(initialHold);
      const { clip, layout } = place(0, { x: .12, y: .255, width: .76, height: .68 }, "來源連續的接管素材", true, undefined, windowKey(0));
      const target = motionSourceLayout(project, mainAsset, { x: 0, y: 0, width: 1, height: 1 }).viewport;
      const a = layout.viewport, factor = target.width / a.width;
      const full = { scale: factor, x: project.width * (target.x + target.width / 2 - a.x - a.width / 2),
        y: project.height * (target.y + target.height / 2 - a.y - a.height / 2) };
      animate(windowKey(0), clip, [{ key: "initial", frame: 0 }, { key: "hold-end", frame: initialHold }, { key: "focus-settle", frame: focusStart, transform: full },
        { key: "focus-hold-end", frame: returnStart, transform: full }, { key: "return-settle", frame: returnStart + move }]);
      if (input.subtitle) quietLine("subtitle", input.subtitle, { ...bandRegion, height: .08 }, returnStart + move, input.durationFrames);
      phase("hold", entrance, initialHold); phase("focus", initialHold, focusStart); phase("hold", focusStart, returnStart);
      phase("return", returnStart, returnStart + move); phase("hold", returnStart + move, input.durationFrames);
    } else {
      // focus_wall: every cell is a silent clone over the blurred primary; the selected source then grows continuously.
      // Three sources read as one triptych row instead of a 2x2 wall with an empty cell.
      const count = sources.length, columns = count === 3 || count > 4 ? 3 : 2, rows = Math.ceil(count / columns);
      const gutter = .025, area = { x: .065, y: .275, width: .87, height: .575 };
      const cellWidth = (area.width - gutter * (columns - 1)) / columns, cellHeight = (area.height - gutter * (rows - 1)) / rows;
      const focusBegin = Math.max(entrance + readingFrames(input.title), Math.ceil(fps * 1.15)), focusEnd = focusBegin + move;
      if (input.durationFrames - focusEnd < Math.ceil(fps * 1.5)) throw new Error("作品牆需要至少 1.5 秒聚焦停留");
      bandLines(input.durationFrames);
      const placed = sources.map((slot, index) => place(index, { x: area.x + index % columns * (cellWidth + gutter),
        y: area.y + Math.floor(index / columns) * (cellHeight + gutter), width: cellWidth, height: cellHeight }, `作品 ${index + 1} · ${slot.label}`, true, undefined, windowKey(index)));
      placed.forEach(({ clip }, index) => animate(windowKey(index), clip, [{ key: "entrance-start", frame: 0, transform: { y: 12 * unit, opacity: 0 } }, { key: "entrance-settle", frame: entrance },
        { key: "focus-start", frame: focusBegin }, { key: "focus-settle", frame: focusEnd, transform: { opacity: index === 0 ? .22 : .25 } }]));
      const { clip: foreground, layout } = place(0, placed[0].layout.viewport, "選中素材連續前景（不是新證據）", true);
      const destination = motionSourceLayout(project, mainAsset, area).viewport, a = layout.viewport;
      const focus = { scale: destination.width / a.width, opacity: 1,
        x: project.width * (destination.x + destination.width / 2 - a.x - a.width / 2),
        y: project.height * (destination.y + destination.height / 2 - a.y - a.height / 2) };
      animate("source:0:foreground", foreground, [{ key: "initial", frame: 0, transform: { opacity: 0 } }, { key: "hidden-hold", frame: Math.max(0, focusBegin - 1), transform: { opacity: 0 } },
        { key: "focus-start", frame: focusBegin }, { key: "focus-settle", frame: focusEnd, transform: focus }]);
      quietLine("source:0:foreground:label", sources[0].label, { x: bandRegion.x, y: area.y + area.height + .018, width: bandRegion.width, height: .07 }, focusEnd, input.durationFrames);
      phase("reveal", 0, entrance); phase("hold", entrance, focusBegin); phase("focus", focusBegin, focusEnd); phase("hold", focusEnd, input.durationFrames - exit);
    }
  } else if (input.templateId === "strike_reframe" && input.strikePresentation === "semantic_replace_v1" && input.strikeSurface === "source_overlay_v2") {
    // On-footage editorial: no backing card. The reading group sits in the caller-observed quiet region of the actual
    // source with white-first ink and a subtle offset shadow; source picture, geometry, window and clocks stay untouched.
    const contract = REFERENCE_MOTION_SOURCE_OVERLAY_V2_CONTRACT, sizes = contract.fontPixels1080, weights = contract.fontWeights;
    const anchor = contract.textRegion.defaultAnchor;
    const region = input.textRegion ?? { x: anchor.x, y: portrait ? anchor.yPortrait : anchor.yLandscape, width: anchor.width, height: undefined };
    const ink = contrast(style.palette.text, "#000000") >= contrast(style.palette.surface, "#000000") ? style.palette.text : style.palette.surface;
    if (contrast(ink, "#000000") < 12) throw new Error("實拍上的白字優先標題需要淺色品牌字色（palette text 或 surface）");
    // The strike crosses glyph strokes and the dark gaps between them; it must stand out against one of the two.
    if (Math.max(contrast(style.palette.accent, ink), contrast(style.palette.accent, "#000000")) < 4.5) throw new Error("刪線強調色在白字與暗部實拍上都不夠清楚；請調整 accent");
    const px = (size: number) => Math.max(8, size * unit), fixedSize = (size: number) => Math.max(8, Math.floor(size * unit));
    // A soft halo scaled to each type size keeps white ink readable where the footage brightens.
    const shade = (size: number) => ({ shadowDepth: contract.shadow.offsetPixels1080 * unit, shadowBlurPixels: Math.round(contract.shadow.haloEm * size * 10) / 10,
      accentColor: contract.shadow.colour, outlineWidth: 0 });
    const still = { ...motion(1, 1, 0), entrance: { ...motion(1, 1, 0).entrance, opacity: 1 }, exit: { ...motion(1, 1, 0).exit, opacity: 1 } };
    const claimExit = { ...motion(1, exit, 0).exit, offsetXPixels: -24 * unit * travel };
    const claimMotion = { ...still, exit: claimExit };
    type Motion = NonNullable<MotionGraphic["motionV2"]>;
    const kineticFor = (name: "drop" | "focus", energy: "hype" | "standard", text: string): Motion =>
      kineticTextMotion(name, { fps, unit, energy, text, animationSpeed: input.style?.animationSpeed ?? 1 });
    const unitsOf = (text: string, value: Motion) => value.sequence.unit === "all" ? 1
      : motionGraphicV2UnitCount({ text, motionV2: { sequence: { unit: value.sequence.unit } } });
    const entranceSpan = (text: string, value: Motion) => value.entrance.durationFrames + (unitsOf(text, value) - 1) * value.sequence.staggerFrames;
    const exitSpan = (text: string, value: Motion) => value.exit.durationFrames + (unitsOf(text, value) - 1) * motionGraphicV2ExitStaggerFrames(value);
    const revealMotion = kineticFor(contract.motion.reveal, contract.motion.revealEnergy, input.title);
    // The support lines share the locked left ink column, so they hold still instead of breathing about their centre.
    const supportMotion = (text: string): Motion => {
      const { holdScale: _breathing, ...sequence } = kineticFor(contract.motion.support, contract.motion.supportEnergy, text).sequence;
      return { ...kineticFor(contract.motion.support, contract.motion.supportEnergy, text), sequence };
    };
    // The complete claim and its location are readable from the first frame; the strike waits for both.
    const struckRead = Math.max(Math.ceil(.3 * fps), cadence.strikeDelayFrames);
    const startStrike = Math.max(readingFrames(input.previousText!),
      input.kicker ? readingFrames(input.kicker) + 1 - cadence.ruleRevealFrames - struckRead : 0);
    const strikeComplete = startStrike + cadence.ruleRevealFrames;
    const previousEnd = strikeComplete + struckRead + exit, newStart = previousEnd;
    const headlineIn = entranceSpan(input.title, revealMotion);
    const supportStart = newStart + Math.max(1, headlineIn - Math.round(.1 * fps)), creditStart = supportStart + Math.round(.2 * fps);
    const textNeed = (text: string | undefined, start: number, value?: Motion) => text && value
      ? start + entranceSpan(text, value) + readingFrames(text) + exitSpan(text, value) : 0;
    const need = Math.max(textNeed(input.title, newStart, revealMotion),
      textNeed(input.subtitle, supportStart, input.subtitle ? supportMotion(input.subtitle) : undefined),
      textNeed(input.brandMark, creditStart, input.brandMark ? supportMotion(input.brandMark) : undefined));
    if (need > input.durationFrames) throw new Error("新主張、說明與字標缺少完整閱讀停留；延長片段或縮短文字");
    // The answer holds for its reading plus a re-read margin, then returns the payoff shot to the footage. Reading is
    // never shortened, and the clean tail is at least the contract's minimum whenever the clip allows it.
    const latestEnd = input.durationFrames - Math.min(Math.round(contract.cleanTailSeconds * fps), input.durationFrames - need);
    const revealEnd = Math.max(need, Math.min(latestEnd, need + Math.round(contract.readingMarginSeconds * fps)));
    // Typeset by physical ink, not by layout boxes: every line shares one left ink column and ink-to-ink gaps scale
    // with the type. A layout box pads its text by max(6, ceil(.28em)); each line is placed so its measured first ink
    // (this copy, face, size and tracking) lands exactly on the intended ink line.
    const column = region.x * project.width, columnWidth = region.width * project.width;
    const pad = (size: number) => Math.max(6, Math.ceil(size * .28));
    const across = (size: number) => ({ x: (column - pad(size)) / project.width, width: (columnWidth + 2 * pad(size)) / project.width });
    const inkOf = (graphic: MotionGraphic) => {
      const segments = layouts.find(r => r.graphicId === graphic.id)!.segments.filter(segment => segment.outline?.ink);
      if (!segments.length) throw new Error("實拍文字需要真正的實體字形邊界");
      return { left: Math.min(...segments.map(s => s.x + s.outline!.ink!.xMin)), right: Math.max(...segments.map(s => s.x + s.outline!.ink!.xMax)),
        top: Math.min(...segments.map(s => s.y + s.outline!.ink!.yMin)), bottom: Math.max(...segments.map(s => s.y + s.outline!.ink!.yMax)) };
    };
    const body = style.typography.bodyFamily, heading = style.typography.headingFamily;
    const placed = (size: number, family: string, weight: number, layoutV2: Overrides["layoutV2"], letterSpacing = 0): Overrides =>
      ({ ...across(px(size)), fontSize: px(size), fontFamily: family, fontWeight: physicalWeight(family, weight), letterSpacing, layoutV2 });
    const at = (text: string, geometry: Overrides, inkTop: number): Overrides =>
      ({ ...geometry, y: (inkTop - firstInkOffset("reel_spatial_headline", text, geometry)) / project.height });
    const gaps = contract.gapEm;
    const location = input.kicker ? add("kicker", "reel_spatial_headline", input.kicker, {
      ...at(input.kicker, placed(sizes.location, body, weights.location, { safeArea, maxLines: 1, minFontSize: fixedSize(sizes.location), lineGap: 0, align: "left" }, 2 * unit), region.y * project.height),
      textColor: `${ink}${contract.inkAlpha.location}`, ...shade(px(sizes.location)), motionV2: claimMotion }, 0, previousEnd) : undefined;
    const claimInkTop = location ? inkOf(location).bottom + gaps.location * px(sizes.claim) : region.y * project.height;
    const claim = add("previous", "reel_spatial_headline", input.previousText!, {
      ...at(input.previousText!, placed(sizes.claim, heading, weights.claim, { safeArea, maxLines: 1, minFontSize: fixedSize(72), lineGap: 0, align: "left" }), claimInkTop),
      textColor: ink, ...shade(px(sizes.claim)), motionV2: claimMotion }, 0, previousEnd);
    if (layouts.find(r => r.graphicId === claim.id)!.lineCount > 1) throw new Error("刪線原句需要單行；請縮短 previousText");
    const claimInk = inkOf(claim), strikeHeight = Math.max(1, contract.strikePixels1080 * unit);
    add("strike", "reel_ink_annotation", "", {
      x: claimInk.left / project.width, y: ((claimInk.top + claimInk.bottom) / 2 - strikeHeight / 2) / project.height,
      width: (claimInk.right - claimInk.left) / project.width,
      fontSize: 8, accentColor: style.palette.accent, cornerRadius: 0, motionV2: { ...motion(1, exit, 0), exit: claimExit },
      layoutV2: { safeArea, maxLines: 1, minFontSize: 8, lineGap: 0, align: "left" },
      vectorV2: { schema: "editkin.motion-vector-annotation/v1", kind: "rule", heightPixels: strikeHeight, revealFrames: cadence.ruleRevealFrames } }, startStrike, previousEnd);
    // The answer replaces the struck claim on the same measured ink line.
    const headline = add("headline", "reel_spatial_headline", input.title, {
      ...at(input.title, placed(sizes.headline, heading, weights.headline, { safeArea, maxLines: 2, minFontSize: fixedSize(sizes.headline), lineGap: 12 * unit, align: "left" }), claimInk.top),
      textColor: ink, ...shade(px(sizes.headline)), motionV2: revealMotion }, newStart, revealEnd);
    const support = input.subtitle ? add("subtitle", "reel_spatial_headline", input.subtitle, {
      ...at(input.subtitle, placed(sizes.support, body, weights.support, { safeArea, maxLines: 2, minFontSize: fixedSize(36), lineGap: 8 * unit, align: "left" }),
        inkOf(headline).bottom + gaps.support * px(sizes.headline)),
      textColor: `${ink}${contract.inkAlpha.support}`, ...shade(px(sizes.support)), motionV2: supportMotion(input.subtitle) }, supportStart, revealEnd) : undefined;
    const credit = input.brandMark ? add("brand-mark", "reel_spatial_headline", input.brandMark, {
      ...at(input.brandMark, placed(sizes.credit, body, weights.credit, { safeArea, maxLines: 1, minFontSize: fixedSize(sizes.credit), lineGap: 0, align: "left" }, 3 * unit),
        inkOf(support ?? headline).bottom + gaps.credit * px(support ? sizes.support : sizes.headline)),
      textColor: `${ink}${contract.inkAlpha.credit}`, ...shade(px(sizes.credit)), motionV2: supportMotion(input.brandMark) }, creditStart, revealEnd) : undefined;
    // Observed negative space is a hard contract on settled ink: no automatic move, shrink or overflow into the subject.
    for (const graphic of [location, claim, headline, support, credit]) {
      if (!graphic) continue;
      const box = layouts.find(r => r.graphicId === graphic.id)!.box, glyphs = inkOf(graphic);
      if (Math.abs(box.x - graphic.x * project.width) > .000001 || Math.abs(box.y - graphic.y * project.height) > .000001) {
        throw new Error("實拍文字無法維持原訂閱讀錨點；請縮短文案，不可自動移動或縮小文字");
      }
      if (glyphs.left < 0 || glyphs.top < 0 || glyphs.right > project.width || glyphs.bottom > project.height) throw new Error("實拍文字超出畫面");
      if (glyphs.right > column + columnWidth + 1 || glyphs.left < column - pad(graphic.fontSize) * .5) throw new Error("實拍文字超出觀察到的留白寬度");
      if (region.height !== undefined && (glyphs.top < region.y * project.height - 1 || glyphs.bottom > (region.y + region.height) * project.height + 1)) {
        throw new Error("文字超出觀察到的實拍留白範圍；請縮短文案或提供較大的留白區");
      }
    }
    phase("hold", 0, startStrike);
    phase("reveal", startStrike, newStart + headlineIn);
    phase("hold", newStart + headlineIn, revealEnd);
  } else if (input.templateId === "strike_reframe" && input.strikePresentation === "semantic_replace_v1" && input.strikeSurface === "source_overlay") {
    // The source remains the scene. Only the measured reading group receives
    // a local matte; no clip placement, source window or media clock changes.
    const still = { ...motion(1, 1, 0),
      entrance: { ...motion(1, 1, 0).entrance, opacity: 1 },
      exit: { ...motion(1, 1, 0).exit, opacity: 1 } };
    const overlay = REFERENCE_MOTION_SOURCE_OVERLAY_CONTRACT;
    const focus = { x: overlay.focusAnchor.x, y: portrait ? overlay.focusAnchor.yPortrait : overlay.focusAnchor.yLandscape, width: overlay.focusAnchor.width };
    const fixedSize = (size: number) => Math.max(8, Math.floor(size * unit));
    const startStrike = entrance + readingFrames(input.previousText!);
    const strikeComplete = startStrike + cadence.ruleRevealFrames;
    const struckRead = Math.max(Math.ceil(.3 * fps), cadence.strikeDelayFrames);
    const previousEnd = strikeComplete + struckRead + exit;
    const newStart = previousEnd;
    const previousMotion = { ...motion(entrance, exit, 18 * unit),
      exit: { ...motion(entrance, exit, 0).exit, offsetXPixels: -18 * unit * travel } };
    const previous = add("previous", "reel_spatial_headline", input.previousText!, {
      ...focus, fontSize: Math.max(8, 84 * unit), fontFamily: style.typography.headingFamily, fontWeight: 700,
      textColor: style.palette.muted, motionV2: previousMotion,
      layoutV2: { safeArea, maxLines: 1, minFontSize: fixedSize(84), lineGap: 0, align: "left" } }, 0, previousEnd);
    const oldLayout = layouts.find(r => r.graphicId === previous.id)!;
    const left = Math.min(...oldLayout.segments.map(s => s.x + s.outline!.ink!.xMin));
    const right = Math.max(...oldLayout.segments.map(s => s.x + s.outline!.ink!.xMax));
    const top = Math.min(...oldLayout.segments.map(s => s.y + s.outline!.ink!.yMin));
    const bottom = Math.max(...oldLayout.segments.map(s => s.y + s.outline!.ink!.yMax));
    const strike = add("strike", "reel_ink_annotation", "", {
      x: left / project.width, y: (top + (bottom - top) * .52) / project.height, width: (right - left) / project.width,
      fontSize: 8, accentColor: style.palette.accent, cornerRadius: 0,
      motionV2: { ...motion(1, exit, 0), exit: { ...motion(1, exit, 0).exit, offsetXPixels: -18 * unit * travel } },
      layoutV2: { safeArea, maxLines: 1, minFontSize: 8, lineGap: 0, align: "left" },
      vectorV2: { schema: "editkin.motion-vector-annotation/v1", kind: "rule", heightPixels: Math.max(1, 4 * unit), revealFrames: cadence.ruleRevealFrames } }, startStrike, previousEnd);
    const mainMotion = { ...motion(entrance, 1, 22 * unit),
      entrance: { ...motion(entrance, 1, 22 * unit).entrance, scale: .96 },
      exit: { ...motion(entrance, 1, 0).exit, opacity: 1 } };
    const headline = add("headline", "reel_spatial_headline", input.title, {
      ...focus, fontSize: Math.max(8, 132 * unit), fontFamily: style.typography.headingFamily, fontWeight: 900,
      textColor: style.palette.text, motionV2: mainMotion,
      layoutV2: { safeArea, maxLines: 2, minFontSize: fixedSize(132), lineGap: 12 * unit, align: "left" } }, newStart);
    const readingGroup = [previous, headline];
    const titleBox = layouts.find(r => r.graphicId === headline.id)!.box;
    const subtitleStart = newStart + entrance + cadence.subtitleDelayFrames;
    if (input.subtitle) readingGroup.push(add("subtitle", "reel_spatial_headline", input.subtitle, {
      x: focus.x, y: (titleBox.y + titleBox.height + 28 * unit) / project.height, width: focus.width,
      fontSize: Math.max(8, 40 * unit), fontFamily: style.typography.bodyFamily, textColor: style.palette.muted,
      motionV2: { ...motion(entrance, 1, 12 * unit), exit: { ...motion(1, 1, 0).exit, opacity: 1 } },
      layoutV2: { safeArea, maxLines: 2, minFontSize: fixedSize(40), lineGap: 8 * unit, align: "left" } }, subtitleStart));
    readingGroup.push(add("kicker", "reel_spatial_headline", input.kicker || "誤解 → 重點", {
      x: focus.x, y: focus.y - (portrait ? .075 : .085), width: focus.width, fontSize: Math.max(8, 30 * unit),
      fontFamily: style.typography.bodyFamily, textColor: style.palette.accent, motionV2: still,
      layoutV2: { safeArea, maxLines: 1, minFontSize: fixedSize(30), lineGap: 0, align: "left" } }));
    const brand = input.brandMark ? add("brand-mark", "reel_spatial_headline", input.brandMark, {
      x: focus.x, y: .085, width: focus.width, fontSize: Math.max(8, 40 * unit), fontFamily: style.typography.bodyFamily,
      textColor: style.palette.text, motionV2: still,
      layoutV2: { safeArea, maxLines: 1, minFontSize: fixedSize(40), lineGap: 0, align: "left" } }) : undefined;

    // Physical outlines are scaled about each segment's local origin in both
    // preview and ASS. The authored ease-in/out phases are monotone, so this
    // envelope includes every combination of their scale/translation limits,
    // including the entrance and the previous claim's leftward exit.
    function physicalEnvelope(graphics: MotionGraphic[]) {
      const points: Array<{ x: number; y: number }> = [];
      for (const graphic of graphics) {
        const receipt = layouts.find(r => r.graphicId === graphic.id)!;
        if (!receipt.physicalFont || !receipt.segments.length) throw new Error("來源疊字需要真正的實體字形邊界");
        if (Math.abs(receipt.box.x - graphic.x * project.width) > .000001 || Math.abs(receipt.box.y - graphic.y * project.height) > .000001) {
          throw new Error("來源疊字無法維持原訂閱讀錨點；請縮短文案，不可自動移動或縮小文字");
        }
        const { entrance: entering, exit: leaving } = graphic.motionV2!;
        const scales = [1, entering.scale, leaving.scale, entering.scale * leaving.scale];
        const dx = [Math.min(0, entering.offsetXPixels) + Math.min(0, leaving.offsetXPixels),
          Math.max(0, entering.offsetXPixels) + Math.max(0, leaving.offsetXPixels)];
        const dy = [Math.min(0, entering.offsetYPixels) + Math.min(0, leaving.offsetYPixels),
          Math.max(0, entering.offsetYPixels) + Math.max(0, leaving.offsetYPixels)];
        for (const segment of receipt.segments) {
          const ink = segment.outline?.ink;
          if (!ink) throw new Error("來源疊字不接受估算或缺失的字形邊界");
          for (const scale of scales) for (const x of [ink.xMin, ink.xMax]) for (const y of [ink.yMin, ink.yMax]) {
            for (const tx of dx) for (const ty of dy) points.push({ x: segment.x + x * scale + tx, y: segment.y + y * scale + ty });
          }
        }
      }
      const bounds = { left: Math.min(...points.map(p => p.x)), top: Math.min(...points.map(p => p.y)),
        right: Math.max(...points.map(p => p.x)), bottom: Math.max(...points.map(p => p.y)) };
      if (Object.values(bounds).some(value => !Number.isFinite(value)) || bounds.right <= bounds.left || bounds.bottom <= bounds.top) {
        throw new Error("來源疊字沒有有效的實體動態邊界");
      }
      return bounds;
    }
    const padding = overlay.paddingPixels1080 * unit;
    function matteRegion(graphics: MotionGraphic[], annotation?: MotionGraphic): NormalizedRect {
      const ink = physicalEnvelope(graphics);
      if (annotation) {
        const box = layouts.find(r => r.graphicId === annotation.id)!.box;
        const entering = annotation.motionV2!.entrance, leaving = annotation.motionV2!.exit;
        ink.left = Math.min(ink.left, box.x + Math.min(0, entering.offsetXPixels) + Math.min(0, leaving.offsetXPixels));
        ink.right = Math.max(ink.right, box.x + box.width + Math.max(0, entering.offsetXPixels) + Math.max(0, leaving.offsetXPixels));
        ink.top = Math.min(ink.top, box.y + Math.min(0, entering.offsetYPixels) + Math.min(0, leaving.offsetYPixels));
        ink.bottom = Math.max(ink.bottom, box.y + box.height + Math.max(0, entering.offsetYPixels) + Math.max(0, leaving.offsetYPixels));
      }
      const left = ink.left - padding, top = ink.top - padding, right = ink.right + padding, bottom = ink.bottom + padding;
      if (left < 0 || top < 0 || right > project.width || bottom > project.height) {
        throw new Error("來源疊字的動態與襯底超出畫面；請縮短文案，不可裁切來源或壓縮閱讀時間");
      }
      return { x: left / project.width, y: top / project.height, width: (right - left) / project.width, height: (bottom - top) / project.height };
    }
    const mainMatte = matteRegion(readingGroup, strike), brandMatte = brand ? matteRegion([brand]) : undefined;
    const mainArea = mainMatte.width * mainMatte.height;
    if ((brandMatte ? 2 : 1) > overlay.maximumPanels || mainArea > overlay.maximumMainArea
      || mainArea + (brandMatte ? brandMatte.width * brandMatte.height : 0) > overlay.maximumCombinedArea) {
      throw new Error("來源疊字襯底遮住過多原畫面；請縮短文案，不可改成全幕圖卡");
    }
    const matteColor = `${style.palette.surface}${overlay.surfaceAlphaHex}`;
    panel("stage", mainMatte, 0, input.durationFrames, matteColor, false, 0, "foreground", false);
    // Keep the saved grid role, confined inside the local matte's padded area.
    add("stage:grid", "reel_line_grid", "", {
      x: mainMatte.x + padding / project.width, y: mainMatte.y + padding / project.height,
      width: mainMatte.width - 2 * padding / project.width, fontSize: 8, compositeLayer: "foreground",
      textColor: `${style.palette.separator}30`, accentColor: `${style.palette.separator}30`,
      layoutV2: { safeArea, maxLines: 1, minFontSize: 8, lineGap: 0, align: "left" }, motionV2: still,
      vectorV2: { schema: "editkin.motion-vector/v1", kind: "line_grid", heightPixels: mainMatte.height * project.height - 2 * padding,
        revealFrames: 1, spacingPixels: 72 * unit, lineWidthPixels: Math.max(.25, unit), majorEvery: 4 } });
    if (brandMatte) panel("brand-mark:panel", brandMatte, 0, input.durationFrames, matteColor, false, 0, "foreground", false);
    // Measuring first must not put the matte over its own content. Reorder the
    // complete authored arrays together, retaining semantic IDs and receipts.
    const orderedKeys = ["stage", "stage:grid", "brand-mark:panel", "previous", "strike", "headline", "subtitle", "kicker", "brand-mark"];
    const orderById = new Map(roles.map(role => [role.id, orderedKeys.indexOf(role.key)]));
    const order = (id: string) => orderById.get(id)!;
    commands.sort((a, b) => {
      if (a.type !== "add_motion_graphic" || b.type !== "add_motion_graphic") throw new Error("來源疊字只能新增圖形，不可修改影片");
      return order(a.graphic.id) - order(b.graphic.id);
    });
    bindings.sort((a, b) => order(a.graphic.id) - order(b.graphic.id));
    layouts.sort((a, b) => order(a.graphicId) - order(b.graphicId));
    roles.sort((a, b) => order(a.id) - order(b.id));
    phase("hold", entrance, startStrike);
    phase("reveal", startStrike, newStart + entrance);
    phase("hold", newStart + entrance, input.durationFrames);
  } else if (input.templateId === "strike_reframe" && input.strikePresentation === "semantic_replace_v1") {
    // Explicit opt-in only. Historical inputs retain the original recipe below.
    // Both semantic states use one focus anchor; the old claim leaves before
    // the replacement enters. Source clips and their clocks are untouched.
    panel("stage", { x: 0, y: 0, width: 1, height: 1 }, 0, input.durationFrames, style.palette.surface, false, 0, "foreground", false);
    const still = { ...motion(1, 1, 0),
      entrance: { ...motion(1, 1, 0).entrance, opacity: 1 },
      exit: { ...motion(1, 1, 0).exit, opacity: 1 } };
    // Retain the old grid semantic ID, but use a quiet footer texture instead
    // of putting a full-screen graph behind the main reading zone.
    add("stage:grid", "reel_line_grid", "", { x: 0, y: .82, width: 1, fontSize: 8, compositeLayer: "foreground",
      textColor: `${style.palette.separator}50`, accentColor: `${style.palette.separator}60`,
      layoutV2: { safeArea, maxLines: 1, minFontSize: 8, lineGap: 0, align: "left" }, motionV2: still,
      vectorV2: { schema: "editkin.motion-vector/v1", kind: "line_grid", heightPixels: .18 * project.height,
        revealFrames: 1, spacingPixels: 72 * unit, lineWidthPixels: Math.max(.25, unit), majorEvery: 4 } });
    const focus = { x: .085, y: portrait ? .335 : .31, width: .83 };
    const startStrike = entrance + readingFrames(input.previousText!);
    const strikeComplete = startStrike + cadence.ruleRevealFrames;
    const struckRead = Math.max(Math.ceil(.3 * fps), cadence.strikeDelayFrames);
    const previousEnd = strikeComplete + struckRead + exit;
    const newStart = previousEnd;
    const previousMotion = { ...motion(entrance, exit, 18 * unit),
      exit: { ...motion(entrance, exit, 0).exit, offsetXPixels: -18 * unit * travel } };
    const previous = add("previous", "reel_spatial_headline", input.previousText!, {
      ...focus, fontSize: 84 * unit, fontFamily: style.typography.headingFamily, fontWeight: 700,
      textColor: style.palette.muted, motionV2: previousMotion,
      layoutV2: { safeArea, maxLines: 1, minFontSize: Math.max(8, 36 * unit), lineGap: 0, align: "left" } }, 0, previousEnd);
    const oldLayout = layouts.find(r => r.graphicId === previous.id)!;
    const left = Math.min(...oldLayout.segments.map(s => s.x + s.outline!.ink!.xMin));
    const right = Math.max(...oldLayout.segments.map(s => s.x + s.outline!.ink!.xMax));
    const top = Math.min(...oldLayout.segments.map(s => s.y + s.outline!.ink!.yMin));
    const bottom = Math.max(...oldLayout.segments.map(s => s.y + s.outline!.ink!.yMax));
    add("strike", "reel_ink_annotation", "", {
      x: left / project.width, y: (top + (bottom - top) * .52) / project.height, width: (right - left) / project.width,
      fontSize: 8, accentColor: style.palette.accent, cornerRadius: 0,
      motionV2: { ...motion(1, exit, 0), exit: { ...motion(1, exit, 0).exit, offsetXPixels: -18 * unit * travel } },
      layoutV2: { safeArea, maxLines: 1, minFontSize: 8, lineGap: 0, align: "left" },
      vectorV2: { schema: "editkin.motion-vector-annotation/v1", kind: "rule", heightPixels: Math.max(1, 4 * unit), revealFrames: cadence.ruleRevealFrames } }, startStrike, previousEnd);
    const mainMotion = { ...motion(entrance, 1, 22 * unit),
      entrance: { ...motion(entrance, 1, 22 * unit).entrance, scale: .96 },
      exit: { ...motion(entrance, 1, 0).exit, opacity: 1 } };
    const headline = add("headline", "reel_spatial_headline", input.title, {
      ...focus, fontSize: 132 * unit, fontFamily: style.typography.headingFamily, fontWeight: 900,
      textColor: style.palette.text, motionV2: mainMotion,
      layoutV2: { safeArea, maxLines: 2, minFontSize: Math.max(8, 48 * unit), lineGap: 12 * unit, align: "left" } }, newStart);
    const titleBox = layouts.find(r => r.graphicId === headline.id)!.box;
    const subtitleStart = newStart + entrance + cadence.subtitleDelayFrames;
    if (input.subtitle) {
      const supportY = (titleBox.y + titleBox.height + 28 * unit) / project.height;
      if (supportY >= .75) throw new Error("新重點佔用了副句閱讀區；請縮短主標或改用較合適的字型");
      const subtitle = add("subtitle", "reel_spatial_headline", input.subtitle, {
        x: focus.x, y: supportY, width: focus.width, fontSize: 40 * unit, fontFamily: style.typography.bodyFamily,
        textColor: style.palette.muted, motionV2: { ...motion(entrance, 1, 12 * unit), exit: { ...motion(1, 1, 0).exit, opacity: 1 } },
        layoutV2: { safeArea, maxLines: 2, minFontSize: Math.max(8, 30 * unit), lineGap: 8 * unit, align: "left" } }, subtitleStart);
      const box = layouts.find(r => r.graphicId === subtitle.id)!.box;
      if (box.y + box.height > .79 * project.height) throw new Error("副句超出閱讀區；請縮短文案");
    }
    const eyebrow = input.kicker || "誤解 → 重點";
    add("kicker", "reel_spatial_headline", eyebrow, {
      x: focus.x, y: portrait ? .245 : .16, width: focus.width, fontSize: 30 * unit,
      fontFamily: style.typography.bodyFamily, textColor: style.palette.accent, motionV2: still,
      layoutV2: { safeArea, maxLines: 1, minFontSize: Math.max(8, 24 * unit), lineGap: 0, align: "left" } });
    if (input.brandMark) add("brand-mark", "reel_spatial_headline", input.brandMark, {
      x: focus.x, y: .085, width: focus.width, fontSize: 40 * unit, fontFamily: style.typography.bodyFamily,
      textColor: style.palette.text, motionV2: still,
      layoutV2: { safeArea, maxLines: 1, minFontSize: Math.max(8, 28 * unit), lineGap: 0, align: "left" } });
    phase("hold", entrance, startStrike);
    phase("reveal", startStrike, newStart + entrance);
    phase("hold", newStart + entrance, input.durationFrames);
  } else if (input.templateId === "strike_reframe") {
    panel("stage", { x: 0, y: 0, width: 1, height: 1 });
    const startStrike = entrance + readingFrames(input.previousText!);
    const newStart = startStrike + cadence.strikeDelayFrames;
    if (input.kicker) text("kicker", input.kicker, .08, .2, .84, 30, 0, input.durationFrames, style.palette.accent, 1);
    const previous = text("previous", input.previousText!, .08, .315, .84, 68, 0, input.durationFrames, style.palette.muted);
    const oldLayout = layouts.find(r => r.graphicId === previous.id)!, oldBox = oldLayout.box;
    const left = Math.min(...oldLayout.segments.map(s => s.x + (options ? s.outline!.ink!.xMin : 0)));
    const right = Math.max(...oldLayout.segments.map(s => s.x + (options ? s.outline!.ink!.xMax : s.width)));
    const strikeY = options ? Math.min(...oldLayout.segments.map(s => s.y + s.outline!.ink!.yMin))
      + (Math.max(...oldLayout.segments.map(s => s.y + s.outline!.ink!.yMax))
        - Math.min(...oldLayout.segments.map(s => s.y + s.outline!.ink!.yMin))) * .52
      : oldBox.y + oldBox.height * .52;
    add("strike", "reel_rule_reveal", "", { x: left / project.width, y: strikeY / project.height, width: (right - left) / project.width,
      fontSize: 8, accentColor: style.palette.accent, cornerRadius: 0, motionV2: motion(1, exit, 0), layoutV2: { safeArea, maxLines: 1, minFontSize: 8, lineGap: 0, align: "left" },
      vectorV2: { schema: "editkin.motion-vector/v1", kind: "rule", heightPixels: Math.max(1, 3 * unit), revealFrames: cadence.ruleRevealFrames } }, startStrike);
    text("headline", input.title, .08, .48, .84, 88, newStart);
    if (input.subtitle) text("subtitle", input.subtitle, .08, .675, .84, 38, newStart + cadence.subtitleDelayFrames, input.durationFrames, style.palette.muted);
    phase("hold", entrance, startStrike); phase("reveal", startStrike, newStart + entrance); phase("hold", newStart + entrance, input.durationFrames - exit);
  } else if (input.templateId === "level_bridge") {
    const paintContract = nativePaintContract;
    const start = nativePaint ? Math.ceil(paintContract.sourceLeadSeconds * fps) : 0;
    const end = nativePaint ? Math.min(start + Math.ceil(paintContract.titleSeconds * fps),
      input.durationFrames - Math.ceil(paintContract.minimumCleanTailSeconds * fps)) : input.durationFrames;
    const nativePanelHeight = input.subtitle ? paintContract.portraitPanelHeights.withSubtitle
      : input.kicker ? paintContract.portraitPanelHeights.withKicker : paintContract.portraitPanelHeights.titleOnly;
    panel("panel", { x: .055, y: .07, width: .89, height: portrait ? nativePaint ? nativePanelHeight : .305 : .5 }, start, end, `${style.palette.surface}F2`, true);
    if (input.kicker) text("kicker", input.kicker, .09, .095, .82, 32, start, end, style.palette.accent, 1);
    const headline = text("headline", input.title, .08, input.kicker ? .165 : .115, .84, 88, start + cadence.shortDelayFrames, end);
    const headlineBox = layouts.find(r => r.graphicId === headline.id)!.box;
    if (input.subtitle) text("subtitle", input.subtitle, .09, Math.max(.275, (headlineBox.y + headlineBox.height + 12 * unit) / project.height), .8, 38, start + cadence.followDelayFrames, end, style.palette.muted);
    const lastDelay = brisk && !input.subtitle ? cadence.shortDelayFrames : cadence.followDelayFrames;
    phase("reveal", start, start + lastDelay + entrance); phase("hold", start + lastDelay + entrance, end - exit);
    if (nativePaint) { phase("return", end - exit, end); phase("hold", end, input.durationFrames); }
  } else if (input.templateId === "brand_recap") {
    // A recap is a sequence of visual emphasis over real footage, not a slide
    // of interchangeable numbered rows. A declared source focus is fitted
    // without stretching; otherwise keep the entire live source visible.
    const items = input.items!;
    if (items.some(item => [...item.label].length > 8)) throw new Error("主視覺短語最多 8 字；較長說明放在 detail，不縮成小字清單");
    const detailDelay = cadence.shortDelayFrames;
    const unitCount = (label: string) => Math.max(1, [...label].filter(character => !/\s/u.test(character)).length);
    const staggerFor = (label: string) => cadence.staggerFrames(unitCount(label));
    const stageFrames = items.map((item, index) => Math.max(
      readingFrames(item.label) + entrance + exit + 2 * Math.max(0, (brisk ? unitCount(item.label) : [...item.label].length) - 1) * staggerFor(item.label),
      item.detail ? readingFrames(item.detail) + entrance + exit + detailDelay : 0,
      readingFrames(`${String(index + 1).padStart(2, "0")}  /  ${String(items.length).padStart(2, "0")}`) + entrance + exit,
    ));
    const totalNeeded = stageFrames.reduce((a, b) => a + b, 0);
    if (totalNeeded > input.durationFrames) throw new Error("逐幕重點缺少閱讀停留；延長影片或減少重點與說明");
    const spare = input.durationFrames - totalNeeded;
    panel("header:panel", { x: 0, y: 0, width: 1, height: portrait ? .215 : .27 });
    panel("footer:panel", { x: 0, y: portrait ? .785 : .73, width: 1, height: portrait ? .215 : .27 });
    place(0, portrait ? { x: 0, y: .215, width: 1, height: .57 } : { x: 0, y: .27, width: 1, height: .46 },
      input.focusRegion ? "已觀察主體範圍，完整容納的素材窗" : "完整來源素材窗（未指定主體裁切）", false, input.focusRegion);
    if (input.kicker) text("kicker", input.kicker, .67, .021, .27, 28, 0, input.durationFrames, style.palette.accent, 1);
    text("headline", input.title, .07, portrait ? .802 : .75, .86, 72, 0, input.durationFrames, style.palette.text, 2);
    let cursor = 0;
    items.forEach((item, index) => {
      const stagger = staggerFor(item.label);
      const start = cursor, end = start + stageFrames[index] + Math.floor(spare / items.length) + (index < spare % items.length ? 1 : 0);
      cursor = end;
      const headingMotion = motion(entrance, exit, 22 * unit);
      add(`item:${index}:label`, "reel_spatial_headline", item.label, { x: .063, y: portrait ? .028 : .018, width: .85,
        fontFamily: style.typography.headingFamily, fontSize: 160 * unit, fontWeight: 800, textColor: style.palette.text, letterSpacing: 2 * unit,
        motionV2: { ...headingMotion, exit: { ...headingMotion.exit, offsetYPixels: -14 * unit * travel }, sequence: { ...headingMotion.sequence, unit: "character", staggerFrames: stagger } },
        layoutV2: { safeArea, maxLines: 1, minFontSize: 70 * unit, lineGap: 0, align: "left" } }, start, end);
      if (item.detail) text(`item:${index}:detail`, item.detail, .07, portrait ? .176 : .17, .86, 36, start + detailDelay, end, style.palette.muted, 1);
      text(`item:${index}:counter`, `${String(index + 1).padStart(2, "0")}  /  ${String(items.length).padStart(2, "0")}`, .075, .915, .35, 34, start, end, style.palette.accent, 1);
      const progressX = .62, progressWidth = .30, gap = .02, barWidth = (progressWidth - gap * (items.length - 1)) / items.length;
      items.forEach((_, bar) => add(`item:${index}:progress:${bar}`, "reel_rule_reveal", "", { x: progressX + bar * (barWidth + gap), y: .936, width: barWidth,
        fontSize: 8, accentColor: bar === index ? style.palette.accent : style.palette.separator, cornerRadius: 0,
        motionV2: motion(1, exit, 0), layoutV2: { safeArea, maxLines: 1, minFontSize: 8, lineGap: 0, align: "left" },
        vectorV2: { schema: "editkin.motion-vector/v1", kind: "rule", heightPixels: Math.max(2, 4 * unit), revealFrames: bar === index ? entrance + detailDelay : 1 } }, start, end));
      const tail = Math.max(0, (brisk ? unitCount(item.label) : [...item.label].length) - 1) * stagger;
      const settled = start + entrance + Math.max(detailDelay, tail);
      phase("reveal", start, settled); phase("hold", settled, end - exit - tail);
    });
  } else if (input.templateId === "context_stack") {
    panel("stage", { x: 0, y: 0, width: 1, height: 1 }); header();
    const items = input.items!, step = cadence.itemStepFrames, count = items.length;
    const rowHeight = Math.min(.155, .54 / count), firstY = .3;
    items.forEach((item, index) => {
      const start = entrance + index * step, y = firstY + index * (rowHeight + .025);
      panel(`item:${index}:shadow`, { x: .075, y: y + .004, width: .86, height: rowHeight }, start, input.durationFrames, "#09142480", true, -18 * unit);
      panel(`item:${index}:panel`, { x: .07, y, width: .86, height: rowHeight }, start, input.durationFrames, style.palette.separator, true, -18 * unit);
      text(`item:${index}:index`, String(index + 1).padStart(2, "0"), .09, y + .014, .13, 40, start, input.durationFrames, style.palette.accent, 1);
      text(`item:${index}:label`, item.label, .235, y + .01, .65, item.detail ? 46 : 52, start, input.durationFrames, style.palette.text, 1);
      if (item.detail) text(`item:${index}:detail`, item.detail, .24, y + .061, .63, 32, start + cadence.shortDelayFrames, input.durationFrames, style.palette.muted, 1);
    });
    const lastIn = entrance + (count - 1) * step + entrance;
    phase("reveal", 0, lastIn); phase("hold", lastIn, input.durationFrames - exit);
  } else if (input.templateId === "comparison_pair") {
    panel("stage", { x: 0, y: 0, width: 1, height: 1 }, 0, input.durationFrames, style.palette.surface, false, 0, "background");
    header();
    const regions = portrait ? [{ x: .065, y: .29, width: .405, height: .43 }, { x: .53, y: .29, width: .405, height: .43 }]
      : [{ x: .065, y: .29, width: .405, height: .46 }, { x: .53, y: .29, width: .405, height: .46 }];
    regions.forEach((region, index) => {
      const role = index === 0 ? "主要比較素材" : "獨立比較素材";
      const { clip } = softComparison ? placeSoftComparison(index, role) : place(index, region, role);
      animate(`source:${index}`, clip, [{ key: "entrance-start", frame: 0, transform: { x: (index === 0 ? -18 : 18) * unit, opacity: 0 } }, { key: "entrance-settle", frame: entrance }]);
      text(`source:${index}:label`, sources[index].label, region.x, .765, region.width, 34, entrance, input.durationFrames, style.palette.text, 1);
    });
    if (input.subtitle) text("subtitle", input.subtitle, .07, .86, .86, 32, entrance, input.durationFrames, style.palette.muted, 1);
    phase("reveal", 0, entrance); phase("hold", entrance, input.durationFrames - exit);
  } else if (input.templateId === "evidence_takeover") {
    const initialHold = entrance + exit + Math.max(readingFrames(input.title), readingFrames(input.kicker ?? ""));
    const focusStart = initialHold + move, returnStart = input.durationFrames - move - cadence.returnHoldFrames;
    if (returnStart - focusStart < Math.ceil(fps * 1.2)) throw new Error("接管場景需要至少 1.2 秒全畫面證據停留；延長片段或縮短標題");
    header(initialHold);
    const { clip, layout } = place(0, { x: .12, y: .255, width: .76, height: .68 }, "來源連續的接管素材");
    // This scene is a 2D evidence handoff, not a fabricated 3D camera move.
    const target = motionSourceLayout(project, mainAsset, { x: 0, y: 0, width: 1, height: 1 }).viewport;
    const a = layout.viewport, factor = target.width / a.width;
    const full = { scale: factor, x: project.width * (target.x + target.width / 2 - a.x - a.width / 2),
      y: project.height * (target.y + target.height / 2 - a.y - a.height / 2) };
    animate("source:0", clip, [{ key: "initial", frame: 0 }, { key: "hold-end", frame: initialHold }, { key: "focus-settle", frame: focusStart, transform: full }, { key: "focus-hold-end", frame: returnStart, transform: full }, { key: "return-settle", frame: returnStart + move }]);
    phase("hold", entrance, initialHold); phase("focus", initialHold, focusStart); phase("hold", focusStart, returnStart);
    phase("return", returnStart, returnStart + move); phase("hold", returnStart + move, input.durationFrames);
  } else if (input.templateId === "focus_wall") {
    panel("stage", { x: 0, y: 0, width: 1, height: 1 }, 0, input.durationFrames, style.palette.surface, false, 0, "background");
    header();
    const count = sources.length, columns = count <= 4 ? 2 : 3, rows = Math.ceil(count / columns);
    const gutter = .025, area = { x: .065, y: .285, width: .87, height: .575 };
    const cellWidth = (area.width - gutter * (columns - 1)) / columns, cellHeight = (area.height - gutter * (rows - 1)) / rows;
    const focusBegin = Math.max(entrance + readingFrames(input.title), Math.ceil(fps * 1.15)), focusEnd = focusBegin + move;
    if (input.durationFrames - focusEnd < Math.ceil(fps * 1.5)) throw new Error("作品牆需要至少 1.5 秒聚焦停留");
    const placed = sources.map((slot, index) => place(index, { x: area.x + index % columns * (cellWidth + gutter),
      y: area.y + Math.floor(index / columns) * (cellHeight + gutter), width: cellWidth, height: cellHeight }, `作品 ${index + 1} · ${slot.label}`));
    placed.forEach(({ clip }, index) => animate(`source:${index}`, clip, [{ key: "entrance-start", frame: 0, transform: { y: 12 * unit, opacity: 0 } }, { key: "entrance-settle", frame: entrance },
      { key: "focus-start", frame: focusBegin }, { key: "focus-settle", frame: focusEnd, transform: { opacity: index === 0 ? .22 : .25 } }]));
    const { clip: foreground, layout } = place(0, placed[0].layout.viewport, "選中素材連續前景（不是新證據）", true);
    const destination = motionSourceLayout(project, mainAsset, area).viewport, a = layout.viewport;
    const focus = { scale: destination.width / a.width, opacity: 1,
      x: project.width * (destination.x + destination.width / 2 - a.x - a.width / 2),
      y: project.height * (destination.y + destination.height / 2 - a.y - a.height / 2) };
    animate("source:0:foreground", foreground, [{ key: "initial", frame: 0, transform: { opacity: 0 } }, { key: "hidden-hold", frame: Math.max(0, focusBegin - 1), transform: { opacity: 0 } },
      { key: "focus-start", frame: focusBegin }, { key: "focus-settle", frame: focusEnd, transform: focus }]);
    text("source:0:foreground:label", sources[0].label, .065, .88, .87, 32, focusEnd, input.durationFrames, style.palette.accent, 1);
    phase("reveal", 0, entrance); phase("hold", entrance, focusBegin); phase("focus", focusBegin, focusEnd); phase("hold", focusEnd, input.durationFrames - exit);
  }
  const declaredPhaseStarts = phases.map(current => current.startFrame);
  if (brisk) {
    // Include late subtitles, group labels and actual complete unit entrances.
    // Existing legacy markers deliberately remain byte-identical. Markers are
    // half-open authoring ranges; an E-frame graphic has settled at E-1.
    phases.forEach((current, index) => {
      if (current.role !== "hold") return;
      const previous = phases[index - 1], windowStart = previous?.startFrame ?? input.startFrame;
      const settled = Math.max(current.startFrame, ...fullEntrances.filter(entry => entry.startFrame >= windowStart
        && entry.startFrame < current.endFrame).map(entry => entry.endFrame));
      // A title ending inside this window can already be exiting before its
      // last frame. Passive panels have no visible exit, and graphics ending
      // before this hold do not shorten later media-only holds. Exit intervals
      // need not be labelled as a steady hold or an early media focus.
      const steadyEnd = Math.min(current.endFrame, ...fullEntrances.filter(entry => entry.exitStartFrame !== undefined
        && entry.graphicEndFrame > current.startFrame && entry.graphicEndFrame <= current.endFrame)
        .map(entry => entry.exitStartFrame!));
      if (settled > steadyEnd) throw new Error("Brisk graphic cadence has no complete readable hold");
      current.startFrame = settled;
      current.endFrame = steadyEnd;
      if (previous && previous.role !== "hold") previous.endFrame = Math.max(previous.endFrame, settled);
    });
  }
  if (phases.some(p => p.endFrame < p.startFrame)) throw new Error("Motion 時序沒有足夠停留");
  // Validation is non-mutating; an invalid compound scene never becomes a partial edit.
  applyCommand(project, { type: "batch", commands });
  // Design themes only: the beats they declared (metadata; commands, roles and the saved instance are unchanged).
  const beats = input.designSystem !== undefined ? emittedBeats(declaredPhaseStarts) : undefined;
  return { schema: options ? "editkin.reference-motion-template/v2" as const : "editkin.reference-motion-template/v1" as const,
    status: "REVIEW_REQUIRED" as const, readOnly: true as const,
    templateId: input.templateId, projectId: project.id, projectRevision: project.revision, commands, bindings, layouts, mediaBindings, phases,
    ...(beats ? { beats } : {}),
    ...(softComparison ? { floatingMediaBindings } : {}),
    ...(brisk ? { graphicCadence: cadence.profile } : {}),
    purpose: input.purpose, evidenceRefs: input.evidenceRefs,
    renderer: options ? "editable EditGraph clips, exact physical glyph contours and Motion v2 vectors / Rec.709 formal output"
      : "editable EditGraph clips and Motion v2 vectors / Rec.709 formal output",
    ...(options ? { roles, authoringGeneration: 2 as const, typography: "physical_glyph_layout_required" as const,
      semanticTiming: "recipe_phases_in_project_frames_not_measured_audio_beats" as const,
      cameraScope: "no_scene_camera_commands; graphic-scoped camera remains separate authoring; media motion uses existing clip keyframes" as const } : {}),
    sourceContinuity: { primaryClipId: original.id, sourceStart: original.sourceStart, playbackRate: 1, originalAudioUnchanged: true },
    sourceCount: sources.length, colorPolicy: REFERENCE_MOTION_COLOR_POLICY, capabilityBoundary: "original 2D compound scenes; focus_wall is planar, not a sphere or 3D studio",
    illustration: input.templateId === "kinetic_network" ? "abstract capability connections; point count does not represent actual members or verified platform outcomes" : undefined,
    evidenceState: "caller_declared_requires_v4_material_receipts", next: "Bind exact commands, variants and material receipts to v4 audit/apply; save, reopen, render and inspect this same project generation." };
}

/** Explicit graphical timing version. The original compiler is unchanged for omitted inputs. */
export function buildReferenceMotionTemplateCommands(project: EditProject, raw: ReferenceMotionTemplateInput, idFactory: (prefix: string) => string,
  options?: ReferenceMotionTemplateCompileOptions) {
  if (raw.graphicTimingV2 === undefined && raw.fixedWindowV3 === undefined && raw.copyFitV3 === undefined && raw.posterV3 === undefined && raw.holdBeatV3 === undefined) return buildReferenceMotionTemplateCommandsV1(project, raw, idFactory, options);
  if (!options || options.generation !== 2) throw new Error("Graphic timing v2 requires current physical glyph layouts");
  const input = referenceMotionTemplateInputSchema.parse(raw);
  const { graphicTimingV2: _timing, fixedWindowV3: _window, copyFitV3: _copy, ...legacyInput } = input;
  // Compute the final graphic clock before the source cycle and its inverse window paths.
  const legacy = input.graphicTimingV2 && input.designSystem !== undefined ? { ...legacyInput, graphicCadence: "legacy" as const } : legacyInput;
  const compile = (effective: ReferenceMotionTemplateInput, currentOptions: ReferenceMotionTemplateCompileOptions) => input.posterV3
    ? compileGraphicPosterPacketV3(effective, currentOptions, () => buildReferenceMotionTemplateCommandsV1(project, effective, idFactory, currentOptions))
    : buildReferenceMotionTemplateCommandsV1(project, effective, idFactory, currentOptions);
  const base = input.copyFitV3 ? compileGraphicCopyFitPacketV3(legacy, input.copyFitV3, options, compile) : compile(legacy, options);
  const timed = input.graphicTimingV2 ? compileGraphicTimingPacketV2(project, input, base, options) : base;
  const held = input.holdBeatV3 ? compileGraphicHoldBeatPacketV3(project, input, timed, options) : timed;
  return input.fixedWindowV3 ? compileFixedTemplateWindowPacketV3(project, input, held, idFactory, options) : held;
}
