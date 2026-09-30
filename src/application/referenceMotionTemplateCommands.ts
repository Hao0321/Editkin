import type { EditorCommand } from "../domain/commandTypes";
import type { ClipLayout, EditProject, MediaAsset, MotionGraphic, NormalizedRect, TimelineClip, Transform2D } from "../domain/types";
import { DEFAULT_TRANSFORM } from "../domain/types";
import { createClipMask } from "../domain/masks";
import { applyCommand } from "../domain/commands";
import { projectDuration } from "../domain/editGraph";
import type { MotionPresetVariant } from "../domain/schema";
import { validateMotionSceneStyle } from "../domain/motionSceneStyle";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { createMotionGraphic } from "../motion/composition";
import { motionGraphicV2LayoutReceipt } from "../motion/compositionV2";
import { CONNECTION_FIELD_GROUP_CENTERS } from "../motion/connectionField";
import { DEFAULT_REFERENCE_MOTION_STYLE, DEFAULT_REFERENCE_NETWORK_COLORS, REFERENCE_MOTION_COLOR_POLICY, referenceMotionTemplate, referenceMotionTemplateInputSchema, type ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";

type Overrides = MotionPresetVariant["overrides"];
export interface ReferenceMotionGraphicBinding {
  graphic: MotionGraphic; presetId: string; overrides: Overrides; startFrame: number; endFrame: number;
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
export function motionSourceLayout(project: Pick<EditProject, "width" | "height">, asset: Pick<MediaAsset, "width" | "height">, region: NormalizedRect): ClipLayout {
  if (!asset.width || !asset.height || asset.width <= 0 || asset.height <= 0) throw new Error("素材槽需要已探測的有效寬高");
  const ratio = asset.width / asset.height, canvasRatio = project.width / project.height;
  const cropWidth = Math.min(1, ratio / canvasRatio), cropHeight = Math.min(1, canvasRatio / ratio);
  const scale = Math.min(region.width / cropWidth, region.height / cropHeight);
  const width = cropWidth * scale, height = cropHeight * scale;
  return { crop: { x: (1 - cropWidth) / 2, y: (1 - cropHeight) / 2, width: cropWidth, height: cropHeight },
    viewport: { x: region.x + (region.width - width) / 2, y: region.y + (region.height - height) / 2, width, height } };
}

/** Pure compound scene compiler used by the inspector and MCP. Nothing executes or reads files here. */
export function buildReferenceMotionTemplateCommands(project: EditProject, raw: ReferenceMotionTemplateInput, idFactory: (prefix: string) => string) {
  const input = referenceMotionTemplateInputSchema.parse(raw);
  const recipe = referenceMotionTemplate(input.templateId), fps = project.fps, portrait = project.height > project.width;
  if (Math.min(project.width, project.height) < 256) throw new Error("Motion 模板需要短邊至少 256 的畫布");
  if (!portrait && input.intent !== "standalone_showcase") throw new Error("長片保留完整素材；整幕 Motion 只能明確指定 standalone_showcase，局部提示請用 prepare_native_motion_sequence");
  if (project.scene25d?.enabled || project.colorManagement?.mode === "aces2") throw new Error("此模板需要一般 Rec.709 2D 專案；不是原生 3D 或 ACES 模板");
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
  const style = validateMotionSceneStyle(input.style ?? (input.templateId === "kinetic_network" ? { ...DEFAULT_REFERENCE_MOTION_STYLE,
    typography: { ...DEFAULT_REFERENCE_MOTION_STYLE.typography, headingFamily: "Noto Sans TC" } } : DEFAULT_REFERENCE_MOTION_STYLE)), unit = Math.min(project.width, project.height) / 1080;
  if (contrast(style.palette.surface, style.palette.text) < 4.5 || contrast(style.palette.surface, style.palette.muted) < 3) throw new Error("品牌文字與底色對比不足，請調整 palette 的 text／muted／surface");
  const frames = (seconds: number) => Math.max(1, Math.round(seconds * fps / style.animationSpeed));
  const readingFrames = (text: string) => Math.ceil((.65 + [...text].length / 8) * fps);
  const entrance = frames(.32), exit = frames(.18), move = frames(.6);
  const commands: EditorCommand[] = [], bindings: ReferenceMotionGraphicBinding[] = [];
  const phases: Array<{ role: "reveal" | "hold" | "focus" | "return"; startFrame: number; endFrame: number }> = [];
  const layouts: ReturnType<typeof motionGraphicV2LayoutReceipt>[] = [];
  const mediaBindings: Array<{ clipId: string; assetId: string; sourceStart: number; role: string; layout: ClipLayout }> = [];
  const safeArea = { top: 0, right: 0, bottom: 0, left: 0 };
  function motion(inFrames = entrance, outFrames = exit, dy = 12 * unit, dx = 0) {
    return { sequence: { unit: "all" as const, order: "forward" as const, exitOrder: "forward" as const, staggerFrames: 0 },
      entrance: { durationFrames: inFrames, offsetXPixels: dx, offsetYPixels: dy, scale: 1, opacity: 0, easing: { type: "ease_out" as const } },
      exit: { durationFrames: outFrames, offsetXPixels: 0, offsetYPixels: 0, scale: 1, opacity: 0, easing: { type: "ease_in" as const } } };
  }
  function add(presetId: string, text: string, overrides: Overrides, start = 0, end = input.durationFrames) {
    if (end <= start) throw new Error("Motion 元素沒有有效範圍");
    const preset = findMotionGraphicPreset(presetId);
    const complete: Overrides = { name: `${recipe.name} · ${text ? text.slice(0, 14) : preset.name}`, backgroundColor: transparent, accentColor: transparent, outlineWidth: 0, shadowDepth: 0,
      fontFamily: style.typography.headingFamily, textColor: style.palette.text, letterSpacing: 0, fontWeight: 700,
      motionV2: motion(), layoutV2: { safeArea, maxLines: 2, minFontSize: Math.max(8, 36 * unit), lineGap: 8 * unit, align: "left" }, ...overrides };
    if (text && end - start - complete.motionV2!.entrance.durationFrames - complete.motionV2!.exit.durationFrames < readingFrames(text)) throw new Error(`文字「${text}」缺少閱讀停留；延長片段或縮短文字`);
    const graphic: MotionGraphic = { ...createMotionGraphic(idFactory("motion-template"), preset.seed.kind ?? "card", text,
      (input.startFrame + start) / fps, (end - start) / fps, undefined, preset.seed), ...structuredClone(complete) };
    const receipt = motionGraphicV2LayoutReceipt(project, graphic);
    const fullEntrance = graphic.motionV2!.entrance.durationFrames + Math.max(0, receipt.unitCount - 1) * graphic.motionV2!.sequence.staggerFrames;
    const fullExit = graphic.motionV2!.exit.durationFrames + Math.max(0, receipt.unitCount - 1) * graphic.motionV2!.sequence.staggerFrames;
    if (text && end - start - fullEntrance - fullExit < readingFrames(text)) throw new Error(`文字「${text}」缺少完整入場後的閱讀停留；延長片段或縮短文字`);
    layouts.push(receipt); bindings.push({ graphic, presetId, overrides: complete, startFrame: input.startFrame + start, endFrame: input.startFrame + end });
    commands.push({ type: "add_motion_graphic", graphic });
    return graphic;
  }
  function panel(region: NormalizedRect, start = 0, end = input.durationFrames, color = style.palette.surface, reveal = false, dx = 0) {
    const background = add("reel_native_panel", "", { ...region, backgroundColor: color, accentColor: transparent, fontSize: 8, cornerRadius: region.x === 0 && region.width === 1 ? 0 : 16 * unit,
      layoutV2: { safeArea, maxLines: 1, minFontSize: 8, lineGap: 0, align: "left" }, motionV2: reveal ? motion(entrance, exit, 0, dx) : {
        ...motion(1, 1, 0), entrance: { ...motion().entrance, durationFrames: 1, opacity: 1, offsetYPixels: 0 }, exit: { ...motion().exit, durationFrames: 1, opacity: 1 } },
      vectorV2: { schema: "editkin.motion-vector/v1", kind: "panel", heightPixels: region.height * project.height, revealFrames: 1 } }, start, end);
    if (region.x === 0 && region.width === 1 && color === style.palette.surface && !reveal) add("reel_line_grid", "", {
      ...region, fontSize: 8, textColor: `${style.palette.accent}30`, accentColor: `${style.palette.accent}1C`,
      layoutV2: { safeArea, maxLines: 1, minFontSize: 8, lineGap: 0, align: "left" },
      motionV2: { ...motion(1, 1, 0), entrance: { ...motion().entrance, durationFrames: 1, opacity: 1, offsetYPixels: 0 }, exit: { ...motion().exit, durationFrames: 1, opacity: 1 } },
      vectorV2: { schema: "editkin.motion-vector/v1", kind: "line_grid", heightPixels: region.height * project.height, revealFrames: 1,
        spacingPixels: 72 * unit, lineWidthPixels: Math.max(.25, unit), majorEvery: 4 } }, start, end);
    return background;
  }
  function text(value: string, x: number, y: number, width: number, size = 68, start = 0, end = input.durationFrames, color = style.palette.text, maxLines = 2) {
    return add("reel_spatial_headline", value, { x, y, width, fontSize: size * unit, textColor: color, fontFamily: size <= 40 ? style.typography.bodyFamily : style.typography.headingFamily,
      layoutV2: { safeArea, maxLines, minFontSize: Math.max(8, Math.min(size, 36) * unit), lineGap: 8 * unit, align: "left" } }, start, end);
  }
  function header(end = input.durationFrames) {
    panel({ x: 0, y: 0, width: 1, height: .235 }, 0, end);
    if (input.kicker) text(input.kicker, .07, .035, .86, 28, 0, end, style.palette.accent, 1);
    text(input.title, .065, input.kicker ? .082 : .065, .87, portrait ? 76 : 68, 0, end);
  }
  function animate(clip: TimelineClip, points: Array<{ frame: number; transform?: Partial<Transform2D> }>) {
    const ordered = new Map(points.map(p => [p.frame, p]));
    for (const point of [...ordered.values()].sort((a, b) => a.frame - b.frame)) commands.push({ type: "add_keyframe", clipId: clip.id,
      keyframe: { id: idFactory("motion-key"), time: point.frame / fps, transform: { ...DEFAULT_TRANSFORM, ...point.transform }, color: structuredClone(clip.color), easing: "ease_in_out" } });
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
    if (index > 0 || clone) {
      const trackId = idFactory("motion-source-track");
      clip = { ...structuredClone(original!), id: idFactory("motion-source-clip"), trackId, assetId: slot.assetId,
        sourceStart: slot.sourceStart, volume: 0, layout, keyframes: [], transform: { ...DEFAULT_TRANSFORM },
        layer: { enabled: true, blendMode: "normal", role: "content" } };
      commands.push({ type: "add_track", track: { id: trackId, name: role, kind: "video", locked: false, muted: false, clips: [] } }, { type: "add_clip", clip });
    } else commands.push({ type: "set_clip_layout", clipId: original!.id, layout });
    const mask = createClipMask(idFactory("motion-edge"), "polygon"), crop = layout.crop;
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
  const phase = (role: typeof phases[number]["role"], start: number, end: number) => phases.push({ role, startFrame: input.startFrame + start, endFrame: input.startFrame + end });

  if (input.templateId === "kinetic_network") {
    // An original abstract explanation with three explicit semantic states.
    // Point geometry is shared SVG/libass, not a video backdrop or HTML animation.
    const items = input.items!, fieldMove = frames(.6);
    const stageFrames = items.map(item => Math.max(readingFrames(item.label), readingFrames(item.detail ?? "")) + Math.max(fieldMove, entrance) + exit);
    const needed = stageFrames.reduce((a, b) => a + b, 0);
    if (needed > input.durationFrames) throw new Error("三幕動態與短語缺少閱讀停留；延長片段或縮短說明");
    const spare = input.durationFrames - needed;
    const lengths = stageFrames.map((length, index) => length + Math.floor(spare / 3) + (index < spare % 3 ? 1 : 0));
    const boundaries = [0, lengths[0], lengths[0] + lengths[1], input.durationFrames];
    panel({ x: 0, y: 0, width: 1, height: 1 });
    if (input.kicker) text(input.kicker, .07, .035, .86, 30, 0, input.durationFrames, style.palette.muted, 1);
    text(input.title, .075, portrait ? .79 : .8, .85, 54, 0, input.durationFrames, style.palette.text, 2);
    const field = { x: .065, y: portrait ? .34 : .385, width: .87, height: portrait ? .4 : .365 };
    const groupColors: [string, string, string] = input.network?.groupColors ?? (input.style ? [style.palette.accent, style.palette.muted, style.palette.separator] : DEFAULT_REFERENCE_NETWORK_COLORS);
    // Translucent capability areas appear when the points settle. Color marks
    // meaning, rather than decorating every word with a different hue.
    if (input.network?.labels) CONNECTION_FIELD_GROUP_CENTERS.forEach((center, index) => {
      const radius = [.15, .14, .16][index];
      add("reel_native_disc", "", { x: field.x + field.width * (center.x - radius), y: field.y + field.height * (center.y - radius),
        width: field.width * radius * 2, fontSize: 8, backgroundColor: `${groupColors[index]}22`,
        layoutV2: { safeArea, maxLines: 1, minFontSize: 8, lineGap: 0, align: "left" },
        vectorV2: { schema: "editkin.motion-vector/v1", kind: "ellipse", heightPixels: field.height * radius * 2 * project.height, revealFrames: 1 } },
      boundaries[1] + fieldMove, input.durationFrames);
    });
    add("reel_connection_field", "", { x: field.x, y: field.y, width: field.width, fontSize: 8,
      textColor: `${style.palette.muted}B0`, accentColor: style.palette.accent, backgroundColor: `${style.palette.muted}50`,
      layoutV2: { safeArea, maxLines: 1, minFontSize: 8, lineGap: 0, align: "left" },
      motionV2: { ...motion(1, 1, 0), entrance: { ...motion().entrance, durationFrames: 1, opacity: 1, offsetYPixels: 0 }, exit: { ...motion().exit, durationFrames: 1, opacity: 1 } },
      vectorV2: { schema: "editkin.motion-vector/v1", kind: "connection_field", heightPixels: project.height * field.height, revealFrames: 1,
        seed: input.network?.seed ?? 32021, points: input.network?.points ?? 32, dotRadiusPixels: Math.min(12, Math.max(1, 9 * unit)), lineWidthPixels: Math.min(8, Math.max(.5, 3 * unit)),
        burstFrames: fieldMove, gatherStartFrame: boundaries[1], gatherFrames: fieldMove,
        connectStartFrame: boundaries[2], connectFrames: fieldMove,
        groupColors } });
    const nodeLabel = (value: string, x: number, y: number, start: number) => add("reel_spatial_headline", value,
      { x: x - .115, y: y - .024, width: .23, fontSize: 46 * unit, fontFamily: style.typography.bodyFamily,
        textColor: style.palette.text, backgroundColor: style.palette.surface, cornerRadius: 6 * unit,
        layoutV2: { safeArea, maxLines: 1, minFontSize: Math.max(8, 34 * unit), lineGap: 0, align: "center", widthMode: "fit_content" } }, start, input.durationFrames);
    input.network?.labels?.forEach((label, index) => {
      const center = CONNECTION_FIELD_GROUP_CENTERS[index];
      nodeLabel(label, field.x + field.width * center.x, field.y + field.height * center.y, boundaries[1] + fieldMove);
    });
    if (input.network?.hubLabel) nodeLabel(input.network.hubLabel, field.x + field.width * .53, field.y + field.height * .55, boundaries[2] + fieldMove);
    items.forEach((item, index) => {
      const start = boundaries[index], end = boundaries[index + 1];
      const headline = add("reel_spatial_headline", item.label, { x: .065, y: portrait ? .12 : .11, width: .87, fontSize: (portrait ? 144 : 112) * unit, fontWeight: 900,
        fontFamily: style.typography.headingFamily, textColor: index === 2 ? style.palette.accent : index === 1 ? style.palette.muted : style.palette.text,
        layoutV2: { safeArea, maxLines: 1, minFontSize: 64 * unit, lineGap: 0, align: "left" },
        motionV2: { ...motion(entrance, exit, 0, 28 * unit),
          entrance: { ...motion().entrance, offsetXPixels: 28 * unit, offsetYPixels: 0, scale: .94 },
          exit: { ...motion().exit, offsetXPixels: -20 * unit, offsetYPixels: 0 } } }, start, end);
      const headlineBox = layouts.find(layout => layout.graphicId === headline.id)!.box;
      if (item.detail) {
        const detailY = Math.max(portrait ? .235 : .30, (headlineBox.y + headlineBox.height + 12 * unit) / project.height);
        const detail = text(item.detail, .08, detailY, .84, 46, start, end, style.palette.muted, 1);
        const detailBox = layouts.find(layout => layout.graphicId === detail.id)!.box;
        if (detailBox.y + detailBox.height >= field.y * project.height) throw new Error("字型比例壓縮了點群空間；請調整主標字型或縮短短句");
      }
      phase(index === 0 ? "reveal" : "focus", start, start + fieldMove);
      const labelEntrance = (index === 1 && input.network?.labels) || (index === 2 && input.network?.hubLabel) ? entrance : 0;
      phase("hold", start + Math.max(fieldMove, entrance) + labelEntrance, end - exit);
    });
  } else if (input.templateId === "strike_reframe") {
    panel({ x: 0, y: 0, width: 1, height: 1 });
    const startStrike = entrance + readingFrames(input.previousText!);
    const newStart = startStrike + frames(.45);
    if (input.kicker) text(input.kicker, .08, .2, .84, 30, 0, input.durationFrames, style.palette.accent, 1);
    const previous = text(input.previousText!, .08, .315, .84, 68, 0, input.durationFrames, style.palette.muted);
    const oldLayout = layouts.find(r => r.graphicId === previous.id)!, oldBox = oldLayout.box;
    const left = Math.min(...oldLayout.segments.map(s => s.x)), right = Math.max(...oldLayout.segments.map(s => s.x + s.width));
    add("reel_rule_reveal", "", { x: left / project.width, y: (oldBox.y + oldBox.height * .52) / project.height, width: (right - left) / project.width,
      fontSize: 8, accentColor: style.palette.accent, cornerRadius: 0, motionV2: motion(1, exit, 0), layoutV2: { safeArea, maxLines: 1, minFontSize: 8, lineGap: 0, align: "left" },
      vectorV2: { schema: "editkin.motion-vector/v1", kind: "rule", heightPixels: Math.max(1, 3 * unit), revealFrames: frames(.4) } }, startStrike);
    text(input.title, .08, .48, .84, 88, newStart);
    if (input.subtitle) text(input.subtitle, .08, .675, .84, 38, newStart + frames(.18), input.durationFrames, style.palette.muted);
    phase("hold", entrance, startStrike); phase("reveal", startStrike, newStart + entrance); phase("hold", newStart + entrance, input.durationFrames - exit);
  } else if (input.templateId === "level_bridge") {
    panel({ x: .055, y: .07, width: .89, height: portrait ? .305 : .5 }, 0, input.durationFrames, `${style.palette.surface}F2`, true);
    if (input.kicker) text(input.kicker, .09, .095, .82, 32, 0, input.durationFrames, style.palette.accent, 1);
    const headline = text(input.title, .08, input.kicker ? .165 : .115, .84, 88, frames(.12));
    const headlineBox = layouts.find(r => r.graphicId === headline.id)!.box;
    if (input.subtitle) text(input.subtitle, .09, Math.max(.275, (headlineBox.y + headlineBox.height + 12 * unit) / project.height), .8, 38, frames(.26), input.durationFrames, style.palette.muted);
    phase("reveal", 0, frames(.26) + entrance); phase("hold", frames(.26) + entrance, input.durationFrames - exit);
  } else if (input.templateId === "brand_recap") {
    // A recap is a sequence of visual emphasis over real footage, not a slide
    // of interchangeable numbered rows. A declared source focus is fitted
    // without stretching; otherwise keep the entire live source visible.
    const items = input.items!;
    if (items.some(item => [...item.label].length > 8)) throw new Error("主視覺短語最多 8 字；較長說明放在 detail，不縮成小字清單");
    const stagger = frames(.035), detailDelay = frames(.12);
    const stageFrames = items.map((item, index) => Math.max(
      readingFrames(item.label) + entrance + exit + 2 * Math.max(0, [...item.label].length - 1) * stagger,
      item.detail ? readingFrames(item.detail) + entrance + exit + detailDelay : 0,
      readingFrames(`${String(index + 1).padStart(2, "0")}  /  ${String(items.length).padStart(2, "0")}`) + entrance + exit,
    ));
    const totalNeeded = stageFrames.reduce((a, b) => a + b, 0);
    if (totalNeeded > input.durationFrames) throw new Error("逐幕重點缺少閱讀停留；延長影片或減少重點與說明");
    const spare = input.durationFrames - totalNeeded;
    panel({ x: 0, y: 0, width: 1, height: portrait ? .215 : .27 });
    panel({ x: 0, y: portrait ? .785 : .73, width: 1, height: portrait ? .215 : .27 });
    place(0, portrait ? { x: 0, y: .215, width: 1, height: .57 } : { x: 0, y: .27, width: 1, height: .46 },
      input.focusRegion ? "已觀察主體範圍，完整容納的素材窗" : "完整來源素材窗（未指定主體裁切）", false, input.focusRegion);
    if (input.kicker) text(input.kicker, .67, .021, .27, 28, 0, input.durationFrames, style.palette.accent, 1);
    text(input.title, .07, portrait ? .802 : .75, .86, 72, 0, input.durationFrames, style.palette.text, 2);
    let cursor = 0;
    items.forEach((item, index) => {
      const start = cursor, end = start + stageFrames[index] + Math.floor(spare / items.length) + (index < spare % items.length ? 1 : 0);
      cursor = end;
      const headingMotion = motion(entrance, exit, 22 * unit);
      add("reel_spatial_headline", item.label, { x: .063, y: portrait ? .028 : .018, width: .85,
        fontFamily: style.typography.headingFamily, fontSize: 160 * unit, fontWeight: 800, textColor: style.palette.text, letterSpacing: 2 * unit,
        motionV2: { ...headingMotion, exit: { ...headingMotion.exit, offsetYPixels: -14 * unit }, sequence: { ...headingMotion.sequence, unit: "character", staggerFrames: stagger } },
        layoutV2: { safeArea, maxLines: 1, minFontSize: 70 * unit, lineGap: 0, align: "left" } }, start, end);
      if (item.detail) text(item.detail, .07, portrait ? .176 : .17, .86, 36, start + frames(.12), end, style.palette.muted, 1);
      text(`${String(index + 1).padStart(2, "0")}  /  ${String(items.length).padStart(2, "0")}`, .075, .915, .35, 34, start, end, style.palette.accent, 1);
      const progressX = .62, progressWidth = .30, gap = .02, barWidth = (progressWidth - gap * (items.length - 1)) / items.length;
      items.forEach((_, bar) => add("reel_rule_reveal", "", { x: progressX + bar * (barWidth + gap), y: .936, width: barWidth,
        fontSize: 8, accentColor: bar === index ? style.palette.accent : style.palette.separator, cornerRadius: 0,
        motionV2: motion(1, exit, 0), layoutV2: { safeArea, maxLines: 1, minFontSize: 8, lineGap: 0, align: "left" },
        vectorV2: { schema: "editkin.motion-vector/v1", kind: "rule", heightPixels: Math.max(2, 4 * unit), revealFrames: bar === index ? entrance + detailDelay : 1 } }, start, end));
      const settled = start + entrance + Math.max(detailDelay, ([...item.label].length - 1) * stagger);
      phase("reveal", start, settled); phase("hold", settled, end - exit - ([...item.label].length - 1) * stagger);
    });
  } else if (input.templateId === "context_stack") {
    panel({ x: 0, y: 0, width: 1, height: 1 }); header();
    const items = input.items!, step = frames(.3), count = items.length;
    const rowHeight = Math.min(.155, .54 / count), firstY = .3;
    items.forEach((item, index) => {
      const start = entrance + index * step, y = firstY + index * (rowHeight + .025);
      panel({ x: .075, y: y + .004, width: .86, height: rowHeight }, start, input.durationFrames, "#09142480", true, -18 * unit);
      panel({ x: .07, y, width: .86, height: rowHeight }, start, input.durationFrames, style.palette.separator, true, -18 * unit);
      text(String(index + 1).padStart(2, "0"), .09, y + .014, .13, 40, start, input.durationFrames, style.palette.accent, 1);
      text(item.label, .235, y + .01, .65, item.detail ? 46 : 52, start, input.durationFrames, style.palette.text, 1);
      if (item.detail) text(item.detail, .24, y + .061, .63, 32, start + frames(.12), input.durationFrames, style.palette.muted, 1);
    });
    const lastIn = entrance + (count - 1) * step + entrance;
    phase("reveal", 0, lastIn); phase("hold", lastIn, input.durationFrames - exit);
  } else if (input.templateId === "comparison_pair") {
    header();
    const regions = portrait ? [{ x: .065, y: .29, width: .405, height: .43 }, { x: .53, y: .29, width: .405, height: .43 }]
      : [{ x: .065, y: .29, width: .405, height: .46 }, { x: .53, y: .29, width: .405, height: .46 }];
    regions.forEach((region, index) => {
      const { clip } = place(index, region, index === 0 ? "主要比較素材" : "獨立比較素材");
      animate(clip, [{ frame: 0, transform: { x: (index === 0 ? -18 : 18) * unit, opacity: 0 } }, { frame: entrance }]);
      text(sources[index].label, region.x, .765, region.width, 34, entrance, input.durationFrames, style.palette.text, 1);
    });
    if (input.subtitle) text(input.subtitle, .07, .86, .86, 32, entrance, input.durationFrames, style.palette.muted, 1);
    phase("reveal", 0, entrance); phase("hold", entrance, input.durationFrames - exit);
  } else if (input.templateId === "evidence_takeover") {
    const initialHold = entrance + exit + Math.max(readingFrames(input.title), readingFrames(input.kicker ?? ""));
    const focusStart = initialHold + move, returnStart = input.durationFrames - move - frames(.65);
    if (returnStart - focusStart < Math.ceil(fps * 1.2)) throw new Error("接管場景需要至少 1.2 秒全畫面證據停留；延長片段或縮短標題");
    header(initialHold);
    const { clip, layout } = place(0, { x: .12, y: .255, width: .76, height: .68 }, "來源連續的接管素材");
    // This scene is a 2D evidence handoff, not a fabricated 3D camera move.
    const target = motionSourceLayout(project, mainAsset, { x: 0, y: 0, width: 1, height: 1 }).viewport;
    const a = layout.viewport, factor = target.width / a.width;
    const full = { scale: factor, x: project.width * (target.x + target.width / 2 - a.x - a.width / 2),
      y: project.height * (target.y + target.height / 2 - a.y - a.height / 2) };
    animate(clip, [{ frame: 0 }, { frame: initialHold }, { frame: focusStart, transform: full }, { frame: returnStart, transform: full }, { frame: returnStart + move }]);
    phase("hold", entrance, initialHold); phase("focus", initialHold, focusStart); phase("hold", focusStart, returnStart);
    phase("return", returnStart, returnStart + move); phase("hold", returnStart + move, input.durationFrames);
  } else if (input.templateId === "focus_wall") {
    header();
    const count = sources.length, columns = count <= 4 ? 2 : 3, rows = Math.ceil(count / columns);
    const gutter = .025, area = { x: .065, y: .285, width: .87, height: .575 };
    const cellWidth = (area.width - gutter * (columns - 1)) / columns, cellHeight = (area.height - gutter * (rows - 1)) / rows;
    const focusBegin = Math.max(entrance + readingFrames(input.title), Math.ceil(fps * 1.15)), focusEnd = focusBegin + move;
    if (input.durationFrames - focusEnd < Math.ceil(fps * 1.5)) throw new Error("作品牆需要至少 1.5 秒聚焦停留");
    const placed = sources.map((slot, index) => place(index, { x: area.x + index % columns * (cellWidth + gutter),
      y: area.y + Math.floor(index / columns) * (cellHeight + gutter), width: cellWidth, height: cellHeight }, `作品 ${index + 1} · ${slot.label}`));
    placed.forEach(({ clip }, index) => animate(clip, [{ frame: 0, transform: { y: 12 * unit, opacity: 0 } }, { frame: entrance },
      { frame: focusBegin }, { frame: focusEnd, transform: { opacity: index === 0 ? .22 : .25 } }]));
    const { clip: foreground, layout } = place(0, placed[0].layout.viewport, "選中素材連續前景（不是新證據）", true);
    const destination = motionSourceLayout(project, mainAsset, area).viewport, a = layout.viewport;
    const focus = { scale: destination.width / a.width, opacity: 1,
      x: project.width * (destination.x + destination.width / 2 - a.x - a.width / 2),
      y: project.height * (destination.y + destination.height / 2 - a.y - a.height / 2) };
    animate(foreground, [{ frame: 0, transform: { opacity: 0 } }, { frame: Math.max(0, focusBegin - 1), transform: { opacity: 0 } },
      { frame: focusBegin }, { frame: focusEnd, transform: focus }]);
    text(sources[0].label, .065, .88, .87, 32, focusEnd, input.durationFrames, style.palette.accent, 1);
    phase("reveal", 0, entrance); phase("hold", entrance, focusBegin); phase("focus", focusBegin, focusEnd); phase("hold", focusEnd, input.durationFrames - exit);
  }
  if (phases.some(p => p.endFrame < p.startFrame)) throw new Error("Motion 時序沒有足夠停留");
  // Validation is non-mutating; an invalid compound scene never becomes a partial edit.
  applyCommand(project, { type: "batch", commands });
  return { schema: "editkin.reference-motion-template/v1" as const, status: "REVIEW_REQUIRED" as const, readOnly: true as const,
    templateId: input.templateId, projectId: project.id, projectRevision: project.revision, commands, bindings, layouts, mediaBindings, phases,
    purpose: input.purpose, evidenceRefs: input.evidenceRefs, renderer: "editable EditGraph clips and Motion v2 vectors / Rec.709 formal output",
    sourceContinuity: { primaryClipId: original.id, sourceStart: original.sourceStart, playbackRate: 1, originalAudioUnchanged: true },
    sourceCount: sources.length, colorPolicy: REFERENCE_MOTION_COLOR_POLICY, capabilityBoundary: "original 2D compound scenes; focus_wall is planar, not a sphere or 3D studio",
    illustration: input.templateId === "kinetic_network" ? "abstract capability connections; point count does not represent actual members or verified platform outcomes" : undefined,
    evidenceState: "caller_declared_requires_v4_material_receipts", next: "Bind exact commands, variants and material receipts to v4 audit/apply; save, reopen, render and inspect this same project generation." };
}
