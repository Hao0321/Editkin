import type { EditorCommand } from "../domain/commandTypes";
import { motionGraphicV2ExitStaggerFrames } from "../domain/motionCompositionV2Contract";
import type { ClipLayout, EditProject, FloatingVideoFrame, MediaAsset, MotionGraphic, NormalizedRect, TimelineClip, Transform2D } from "../domain/types";
import { DEFAULT_TRANSFORM } from "../domain/types";
import { createClipMask } from "../domain/masks";
import { applyCommand } from "../domain/commands";
import { projectDuration } from "../domain/editGraph";
import type { MotionPresetVariant } from "../domain/schema";
import { validateMotionSceneStyle } from "../domain/motionSceneStyle";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { createMotionGraphic } from "../motion/composition";
import { motionGraphicV2LayoutReceipt, prepareMotionGraphicV2FrameLayout, type MotionGraphicV2LayoutReceipt } from "../motion/compositionV2";
import { CONNECTION_FIELD_GROUP_CENTERS } from "../motion/connectionField";
import { floatingFrameLayout, type FloatingFrameLayout } from "../motion/floatingVideoFrame";
import { compileGraphicCadence } from "../motion/graphicCadence";
import { DEFAULT_REFERENCE_MOTION_STYLE, DEFAULT_REFERENCE_NETWORK_COLORS, REFERENCE_MOTION_COLOR_POLICY, REFERENCE_MOTION_SOURCE_OVERLAY_CONTRACT, REFERENCE_MOTION_NATIVE_PAINT_PRESENTATION_CONTRACT, REFERENCE_MOTION_DISPLAY_PAINT_PRESENTATION_CONTRACT, isNativeReferenceMotionPresentation, referenceMotionTemplate, referenceMotionTemplateInputSchema, type ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";

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

/** Pure compound scene compiler used by the inspector and MCP. Nothing executes or reads files here. */
export function buildReferenceMotionTemplateCommands(project: EditProject, raw: ReferenceMotionTemplateInput, idFactory: (prefix: string) => string,
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
  const track = project.tracks.find(track => track.kind === "video" && !track.locked && !track.muted && track.clips.some(c => c.id === input.clipId));
  const original = track?.clips.find(c => c.id === input.clipId);
  const mainAsset = project.assets.find(a => a.id === original?.assetId);
  if (!original || !mainAsset || mainAsset.kind !== "video" || mainAsset.compositionId) throw new Error("模板需要可編輯的真實影片 clipId");
  if (Math.round(original.timelineStart * fps) !== input.startFrame || Math.round(original.duration * fps) !== input.durationFrames) throw new Error("模板範圍必須精確對應片段；先用原生剪裁命令準備該段");
  if (project.motionGraphics.some(g => g.timelineStart < (input.startFrame + input.durationFrames) / fps && g.timelineStart + g.duration > input.startFrame / fps)) throw new Error("此段已有 Motion；請局部修訂或先移除，避免重複套用與文字重疊");
  if (input.sources.length < recipe.sourceSlots || input.sources.length > recipe.maxSources) throw new Error(`模板需要 ${recipe.sourceSlots} 至 ${recipe.maxSources} 個額外獨立素材槽`);
  const sources = [{ assetId: mainAsset.id, sourceStart: original.sourceStart, label: input.primaryLabel ?? "主要素材" }, ...input.sources];
  const sourceAssets = sources.map(slot => {
    const asset = project.assets.find(a => a.id === slot.assetId);
    if (!asset || asset.kind !== "video" || asset.compositionId || (asset.color?.interpretation ?? "rec709") !== "rec709"
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
  if (input.network && input.templateId !== "kinetic_network") throw new Error("network 參數只適用能力連結場景");
  if (input.focusRegion && input.templateId !== "brand_recap") throw new Error("主體取景只適用素材回顧場景");
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
  const cadence = compileGraphicCadence(fps, style.animationSpeed, input.graphicCadence), brisk = cadence.profile === "brisk";
  const readingFrames = (text: string) => Math.ceil((.65 + [...text].length / 8) * fps);
  const entrance = cadence.entranceFrames, exit = cadence.exitFrames, move = cadence.moveFrames;
  const commands: EditorCommand[] = [], bindings: ReferenceMotionGraphicBinding[] = [];
  const roles: ReferenceMotionTemplateRole[] = [];
  function roleId(key: string, kind: ReferenceMotionTemplateRole["kind"], prefix: string, parentId?: string, existingId?: string) {
    if (roles.some(role => role.key === key)) throw new Error(`Duplicate template semantic role: ${key}`);
    const role = { key, kind, ...(parentId === undefined ? {} : { parentId }) };
    const id = existingId ?? options?.allocateRoleId?.(role, prefix) ?? idFactory(prefix);
    if (!id || roles.some(previous => previous.id === id)) throw new Error(`Duplicate or missing template role identity: ${key}`);
    roles.push({ ...role, id }); return id;
  }
  const phases: Array<{ role: "reveal" | "hold" | "focus" | "return"; startFrame: number; endFrame: number }> = [];
  const fullEntrances: Array<{ startFrame: number; endFrame: number; graphicEndFrame: number; exitStartFrame?: number }> = [];
  const layouts: ReturnType<typeof motionGraphicV2LayoutReceipt>[] = [];
  const mediaBindings: Array<{ clipId: string; assetId: string; sourceStart: number; role: string; layout: ClipLayout }> = [];
  const floatingMediaBindings: ReferenceMotionFloatingMediaBinding[] = [];
  const safeArea = { top: 0, right: 0, bottom: 0, left: 0 };
  function motion(inFrames = entrance, outFrames = exit, dy = 12 * unit, dx = 0) {
    return { sequence: { unit: "all" as const, order: "forward" as const, exitOrder: "forward" as const, staggerFrames: 0 },
      entrance: { durationFrames: inFrames, offsetXPixels: dx, offsetYPixels: dy, scale: 1, opacity: 0, easing: { type: "ease_out" as const } },
      exit: { durationFrames: outFrames, offsetXPixels: 0, offsetYPixels: 0, scale: 1, opacity: 0, easing: { type: "ease_in" as const } } };
  }
  function add(role: string, presetId: string, text: string, overrides: Overrides, start = 0, end = input.durationFrames) {
    if (end <= start) throw new Error("Motion 元素沒有有效範圍");
    const preset = findMotionGraphicPreset(presetId);
    const complete: Overrides = { name: `${recipe.name} · ${text ? text.slice(0, 14) : preset.name}`, backgroundColor: transparent, accentColor: transparent, outlineWidth: 0, shadowDepth: 0,
      fontFamily: style.typography.headingFamily, textColor: style.palette.text, letterSpacing: 0, fontWeight: 700,
      motionV2: motion(), layoutV2: { safeArea, maxLines: 2, minFontSize: Math.max(8, 36 * unit), lineGap: 8 * unit, align: "left" }, ...overrides };
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
    if (text && end - start - complete.motionV2!.entrance.durationFrames - complete.motionV2!.exit.durationFrames < readingFrames(text)) throw new Error(`文字「${text}」缺少閱讀停留；延長片段或縮短文字`);
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
    } else receipt = motionGraphicV2LayoutReceipt(project, graphic);
    const fullEntrance = graphic.motionV2!.entrance.durationFrames + Math.max(0, receipt.unitCount - 1) * graphic.motionV2!.sequence.staggerFrames;
    const fullExit = graphic.motionV2!.exit.durationFrames + Math.max(0, receipt.unitCount - 1) * motionGraphicV2ExitStaggerFrames(graphic.motionV2!);
    if (text && end - start - fullEntrance - fullExit < readingFrames(text)) throw new Error(`文字「${text}」缺少完整入場後的閱讀停留；延長片段或縮短文字`);
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
  function animate(role: string, clip: TimelineClip, points: Array<{ key: string; frame: number; transform?: Partial<Transform2D> }>) {
    const ordered = new Map(points.map(p => [p.frame, p]));
    for (const point of [...ordered.values()].sort((a, b) => a.frame - b.frame)) commands.push({ type: "add_keyframe", clipId: clip.id,
      keyframe: { id: roleId(`${role}:${point.key}`, "keyframe", "motion-key", clip.id), time: point.frame / fps, transform: { ...DEFAULT_TRANSFORM, ...point.transform }, color: structuredClone(clip.color), easing: "ease_in_out" } });
  }
  function place(index: number, region: NormalizedRect, role: string, clone = false, focus?: NormalizedRect) {
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
    const semanticRole = clone ? `source:${index}:foreground` : `source:${index}`;
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
    mask.name = "影片窗柔和圓角"; mask.feather = .0015; mask.expansion = 0; mask.refine.chatterReduction = 0;
    const rx = Math.min(crop.width / 8, 32 * unit / project.width), ry = Math.min(crop.height / 8, 32 * unit / project.height);
    const corners = [[crop.x + crop.width - rx, crop.y + ry, -90], [crop.x + crop.width - rx, crop.y + crop.height - ry, 0],
      [crop.x + rx, crop.y + crop.height - ry, 90], [crop.x + rx, crop.y + ry, 180]];
    mask.path = corners.flatMap(([cx, cy, angle], corner) => Array.from({ length: 5 }, (_, step) => {
      const theta = (angle + step * 90 / 4) * Math.PI / 180;
      return { id: `corner-${corner}-${step}`, x: Math.max(0, Math.min(1, cx + rx * Math.cos(theta))), y: Math.max(0, Math.min(1, cy + ry * Math.sin(theta))) };
    }));
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

  if (input.templateId === "kinetic_network") {
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
          entrance: { ...motion().entrance, offsetXPixels: 28 * unit, offsetYPixels: 0, scale: .94 },
          exit: { ...motion().exit, offsetXPixels: -20 * unit, offsetYPixels: 0 } } }, start, end);
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
      exit: { ...motion(entrance, exit, 0).exit, offsetXPixels: -18 * unit } };
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
      motionV2: { ...motion(1, exit, 0), exit: { ...motion(1, exit, 0).exit, offsetXPixels: -18 * unit } },
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
      exit: { ...motion(entrance, exit, 0).exit, offsetXPixels: -18 * unit } };
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
      motionV2: { ...motion(1, exit, 0), exit: { ...motion(1, exit, 0).exit, offsetXPixels: -18 * unit } },
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
        motionV2: { ...headingMotion, exit: { ...headingMotion.exit, offsetYPixels: -14 * unit }, sequence: { ...headingMotion.sequence, unit: "character", staggerFrames: stagger } },
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
  return { schema: options ? "editkin.reference-motion-template/v2" as const : "editkin.reference-motion-template/v1" as const,
    status: "REVIEW_REQUIRED" as const, readOnly: true as const,
    templateId: input.templateId, projectId: project.id, projectRevision: project.revision, commands, bindings, layouts, mediaBindings, phases,
    ...(softComparison ? { floatingMediaBindings } : {}),
    ...(brisk ? { graphicCadence: "brisk" as const } : {}),
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
