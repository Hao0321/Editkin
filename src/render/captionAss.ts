import type { CaptionStyle, EditProject, MotionGraphic } from "../domain/types";
import { resolveBundledFontFace } from "../typography/fontFaces";
import { bundledFontAssMetrics } from "../typography/fontEmMetrics";
import { motionGraphicV2FrameReceipt, motionGraphicV2LayoutReceipt, prepareMotionGraphicV2FrameLayout, type MotionGraphicV2LayoutReceipt } from "../motion/compositionV2";
import { assertMotionGraphicV2Contract } from "../domain/motionCompositionV2Contract";
import { motionPanelPaths } from "../motion/panelGeometry";
import { motionVectorPaths } from "../motion/vectorGeometry";
import { AssMotionBudget, assMotionFrameRange, assUtf8Bytes } from "./assMotionBudget";
import { assertMotionScenes2DPreparedFrameRange, prepareMotionSceneCamera2D, projectMotionScenePoint } from "../motion/sceneCamera2d";

function assColor(hex: string, opacityMultiplier = 1): string {
  const clean = hex.replace("#", "").padEnd(6, "F");
  const rgb = clean.slice(0, 6);
  const cssAlpha = clean.length >= 8 ? Number.parseInt(clean.slice(6, 8), 16) : 255;
  const effectiveAlpha = Math.round((Number.isFinite(cssAlpha) ? cssAlpha : 255) * Math.max(0, Math.min(1, opacityMultiplier)));
  const assAlpha = (255 - effectiveAlpha).toString(16).padStart(2, "0").toUpperCase();
  return `&H${assAlpha}${rgb.slice(4, 6)}${rgb.slice(2, 4)}${rgb.slice(0, 2)}`;
}

function assOverrideColor(hex: string, channel: 1 | 3 | 4, opacity: number): string {
  const color = assColor(hex, opacity);
  // Style colors are AABBGGRR, but override color tags only accept BBGGRR.
  // Alpha is a separate channel tag; embedding it in \c silently loses fades.
  return `\\${channel}c&H${color.slice(4)}&\\${channel}a&H${color.slice(2, 4)}&`;
}

function assTime(seconds: number): string {
  const centiseconds = Math.max(0, Math.round(seconds * 100));
  return assCentiseconds(centiseconds);
}

function assCentiseconds(centiseconds: number): string {
  const hours = Math.floor(centiseconds / 360000);
  const minutes = Math.floor((centiseconds % 360000) / 6000);
  const secs = Math.floor((centiseconds % 6000) / 100);
  const fraction = centiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(fraction).padStart(2, "0")}`;
}

/** ASS events use centiseconds, while output samples are integer video frames.
 * A rounded-up event boundary selects the PREVIOUS state at the frame's PTS.
 * Floor both ends of the half-open interval instead. This cannot represent
 * >100 unique frames per second; refuse that adapter rather than drop states. */
export function assMotionFrameTime(frame: number, fps: number): string {
  if (!Number.isSafeInteger(frame) || frame < 0 || !Number.isFinite(fps) || fps <= 0 || fps > 100) throw new Error("ASS 動態文字輸出無法逐格呈現此幀率（支援最高 100 fps）");
  const centiseconds = Math.floor(frame * 100 / fps + 1e-7);
  if (!Number.isSafeInteger(centiseconds) || centiseconds < 0) throw new Error("ASS derived centiseconds timestamp 超出安全整數範圍");
  return assCentiseconds(centiseconds);
}

function assText(text: string): string {
  return text.replaceAll("\\", "／").replaceAll("{", "（").replaceAll("}", "）").replaceAll("\n", "\\N").replaceAll(",", "，");
}

function assFontName(value: string): string {
  return value.replace(/[{},\\\r\n]/g, " ").replaceAll(",", " ").trim();
}

function assFace(family: string, requestedWeight: number, bundledFaces: boolean) {
  const resolved = resolveBundledFontFace(family, requestedWeight);
  return bundledFaces && resolved ? resolved : { fontFamily: family, fontWeight: requestedWeight };
}

function graphicOverrides(graphic: MotionGraphic, x: number, y: number, animate = true, bundledFaces = true): string {
  const startX = Math.round(x);
  const startY = Math.round(y);
  const face = assFace(graphic.fontFamily ?? "Noto Sans TC", graphic.fontWeight ?? 700, bundledFaces);
  const font = `\\fn${assFontName(face.fontFamily)}`;
  const weight = `\\b${face.fontWeight}`;
  const spacing = `\\fsp${Math.round(graphic.letterSpacing ?? 0)}`;
  const border = Math.round(graphic.outlineWidth ?? (graphic.kind === "card" ? 14 : 7));
  const shadow = Math.round(graphic.shadowDepth ?? 2);
  const base = `\\an7${font}${weight}${spacing}\\fs${Math.round(graphic.fontSize)}${assOverrideColor(graphic.textColor, 1, 1)}${assOverrideColor(graphic.backgroundColor, 3, 1)}${assOverrideColor(graphic.accentColor, 4, 1)}\\bord${border}\\shad${shadow}`;
  if (!animate) return `{${base}\\pos(${startX},${startY})}`;
  if (graphic.animation === "slide_up") return `{${base}\\move(${startX},${startY + 36},${startX},${startY},0,360)\\fad(160,140)}`;
  if (graphic.animation === "pop") return `{${base}\\pos(${startX},${startY})\\fscx70\\fscy70\\t(0,260,\\fscx100\\fscy100)\\fad(90,140)}`;
  if (graphic.animation === "spring_soft") return `{${base}\\pos(${startX},${startY})\\fscx72\\fscy72\\t(0,210,\\fscx108\\fscy108)\\t(210,390,\\fscx100\\fscy100)\\fad(80,140)}`;
  return `{${base}\\pos(${startX},${startY})\\fad(180,140)}`;
}

export interface MotionAssOptions {
  bundledFaces?: boolean;
  compositeLayer?: "background" | "foreground";
  physicalLayouts?: ReadonlyMap<string, MotionGraphicV2LayoutReceipt>;
  requirePhysicalGlyphs?: boolean;
  /** One provider per resolved output, shared by its foreground/background
   * scripts. Absent a provider, the actual cap applies to this script only. */
  aggregateBudget?: AssMotionBudget;
}

/** Admit project-wide cost before retaining output or entering a frame loop.
 * Both composite layers contribute to the admission estimates. Exact actual
 * bytes/work span both scripts only with their shared aggregate provider;
 * standalone calls have a single-script actual cap. Excluded-layer receipts
 * are not required by this adapter.
 * 512 bytes per estimated event is a conservative source envelope allowance;
 * dynamic vector/panel path bytes still require the actual addLine guard. */
export function admitAssMotionProject(project: EditProject, style: CaptionStyle, options: MotionAssOptions = {}, budget = options.aggregateBudget?.fork() ?? new AssMotionBudget()): AssMotionBudget {
  budget.admit({ events: project.captions.length });
  // Admit all sample work before inspecting or copying any physical contours.
  for (const graphic of project.motionGraphics) {
    if (graphic.schema === "hao.motion-composition/v2") {
      const { durationFrames } = assMotionFrameRange(graphic.timelineStart, graphic.duration, project.fps);
      budget.admit({ sampleEvaluations: durationFrames });
      assertMotionGraphicV2Contract(graphic, project.fps);
    } else if (graphic.trackId) {
      budget.admit({ sampleEvaluations: project.motionTracks.find(item => item.id === graphic.trackId)?.points.length ?? 0 });
    }
  }
  const primaryBytes = assUtf8Bytes(style.fontFamily), secondaryBytes = assUtf8Bytes(style.translationFontFamily);
  budget.admit({ utf8Bytes: 2048 + 3 * (primaryBytes + secondaryBytes) });
  for (const caption of project.captions) {
    budget.admit({ utf8Bytes: 512 + primaryBytes + 3 * assUtf8Bytes(caption.text)
      + (caption.translation?.text.trim() ? secondaryBytes + 3 * assUtf8Bytes(caption.translation.text) : 0) });
  }
  for (const graphic of project.motionGraphics) {
    if (graphic.schema !== "hao.motion-composition/v2") {
      const track = graphic.trackId ? project.motionTracks.find(item => item.id === graphic.trackId) : undefined;
      const events = graphic.trackId ? track?.points.length ?? 0 : 1;
      budget.admit({ events,
        utf8Bytes: events * (512 + assUtf8Bytes(graphic.fontFamily ?? "Noto Sans TC") + 3 * assUtf8Bytes(graphic.text)) });
      continue;
    }
    const { durationFrames } = assMotionFrameRange(graphic.timelineStart, graphic.duration, project.fps);
    const layout = !graphic.vectorV2 ? options.physicalLayouts?.get(graphic.id) : undefined;
    const panelEvents = /^#[0-9a-f]{6}00$/i.test(graphic.backgroundColor) ? 0 : 2;
    let eventsPerFrame: number, payloadBytesPerFrame = 0;
    if (graphic.vectorV2) {
      eventsPerFrame = graphic.vectorV2.kind === "connection_field" ? 5
        : ["panel", "spring_panel", "step_progress", "line_grid"].includes(graphic.vectorV2.kind) ? 2 : 1;
    } else if (layout?.physicalFont) {
      const copies = graphic.shadowDepth ? 2 : 1;
      let contours = 0;
      for (const segment of layout.segments) {
        if (!segment.outline?.ass) continue;
        contours++;
        payloadBytesPerFrame += assUtf8Bytes(segment.outline.ass) * copies;
      }
      eventsPerFrame = panelEvents + contours * copies;
    } else {
      // Legacy layout can split a unit at line boundaries; the scalar text
      // count bounds those segments without fitting or evaluating any frames.
      eventsPerFrame = panelEvents + Math.max(1, [...graphic.text].length);
      payloadBytesPerFrame = 3 * assUtf8Bytes(graphic.text)
        + eventsPerFrame * assUtf8Bytes(graphic.fontFamily ?? "Noto Sans TC");
    }
    budget.admit({ events: durationFrames * eventsPerFrame,
      utf8Bytes: durationFrames * (512 * eventsPerFrame + payloadBytesPerFrame) + 512 + 3 * assUtf8Bytes(graphic.id) });
  }
  return budget;
}

function motionGraphicEvents(project: EditProject, bundledFaces: boolean, options: MotionAssOptions, budget: AssMotionBudget, cameraScope: ReturnType<typeof prepareMotionSceneCamera2D>): void {
  for (const graphic of project.motionGraphics) {
    if (graphic.schema === "hao.motion-composition/v2") {
      motionGraphicV2Events(project, graphic, bundledFaces, options, budget, cameraScope); continue;
    }
    const text = assText(graphic.text);
    if (!graphic.trackId) {
      const overrides = graphicOverrides(graphic, graphic.x * project.width, graphic.y * project.height, true, bundledFaces);
      budget.addLine(`Dialogue: 1,${assTime(graphic.timelineStart)},${assTime(graphic.timelineStart + graphic.duration)},Motion,,0,0,0,,${overrides}${text}`); continue;
    }
    const track = project.motionTracks.find((item) => item.id === graphic.trackId);
    const clip = track && project.tracks.flatMap((item) => item.clips).find((item) => item.id === track.clipId);
    if (!track || !clip) continue;
    for (const [index, point] of track.points.entries()) {
      budget.takeSample();
      if (point.status === "lost") continue;
      const start = Math.max(graphic.timelineStart, clip.timelineStart + point.time);
      const nextTime = track.points[index + 1]?.time ?? point.time + 1 / track.analysisFps;
      const end = Math.min(graphic.timelineStart + graphic.duration, clip.timelineStart + nextTime);
      if (end <= start) continue;
      const safeMargin = 40;
      const unclampedX = (point.rect.x + point.rect.width + graphic.offsetX) * project.width;
      const unclampedY = (point.rect.y + graphic.offsetY) * project.height;
      const maxX = Math.max(safeMargin, project.width - graphic.width * project.width - safeMargin);
      const maxY = Math.max(safeMargin, project.height - graphic.fontSize * 2 - safeMargin);
      const x = Math.min(maxX, Math.max(safeMargin, unclampedX));
      const y = Math.min(maxY, Math.max(safeMargin, unclampedY));
      budget.addLine(`Dialogue: 1,${assTime(start)},${assTime(end)},Motion,,0,0,0,,${graphicOverrides(graphic, x, y, false, bundledFaces)}${text}`);
    }
  }
}

function motionGraphicV2Events(project: EditProject, graphic: MotionGraphic, bundledFaces: boolean, options: MotionAssOptions, budget: AssMotionBudget, cameraScope: ReturnType<typeof prepareMotionSceneCamera2D>): void {
  if (graphic.paintV1) throw new Error("Native paint cannot be exported as plain ASS colors; use the matching native paint renderer");
  if (!bundledFaces) throw new Error("v2 動態文字輸出需要已驗證的內建字型，不能改用未驗證替代字型");
  const { startFrame, durationFrames } = assMotionFrameRange(graphic.timelineStart, graphic.duration, project.fps);
  const initialCamera = cameraScope.sample(graphic.id, startFrame);
  const supplied = !graphic.vectorV2 || initialCamera.active ? options.physicalLayouts?.get(graphic.id) : undefined;
  if (!graphic.vectorV2 && (options.requirePhysicalGlyphs || supplied) && !supplied?.physicalFont) throw new Error(`實體 glyph ${graphic.id} 缺少 physical layout receipt`);
  const layout = prepareMotionGraphicV2FrameLayout(project, graphic, supplied ?? motionGraphicV2LayoutReceipt(project, graphic));
  if (initialCamera.active && !graphic.vectorV2 && !layout.physicalFont) throw new Error("scene2d camera requires a physical glyph layout receipt; estimated text is unsupported");
  assMotionFrameTime(startFrame, project.fps);
  budget.addLine(`; MotionCompositionV2Receipt: ${graphic.id},${layout.receiptId},${durationFrames}`);
  if (initialCamera.sceneId) budget.addLine(`; MotionSceneCamera2DReceipt: ${graphic.id},${initialCamera.sceneId},${cameraScope.sourceSignature}`);
  if (layout.physicalFont) {
    const physical = layout.physicalFont;
    budget.addLine(`; MotionPhysicalGlyph: ${graphic.id},${physical.faceId},${physical.fontSha256},${physical.manifestSha256},${physical.parserVersion}`);
  }
  const face = assFace(graphic.fontFamily ?? "Noto Sans TC", graphic.fontWeight ?? 700, bundledFaces);
  const font = `\\fn${assFontName(face.fontFamily)}`;
  const weight = `\\b${face.fontWeight}`;
  const spacing = `\\fsp${Math.round(graphic.letterSpacing ?? 0)}`;
  const panel = motionPanelPaths(layout.box.width, layout.box.height, graphic.cornerRadius ?? 10, graphic.outlineWidth ?? 2);
  const shadow = Math.round(graphic.shadowDepth ?? 2);
  const metrics = layout.physicalFont ? undefined : bundledFontAssMetrics(graphic.fontFamily ?? "Noto Sans TC", graphic.fontWeight ?? 700, layout.fontSize, layout.lineHeight);
  const segmentById = new Map(layout.segments.map((segment) => [segment.id, segment]));
  for (let localFrame = 0; localFrame < durationFrames; localFrame += 1) {
    budget.takeSample();
    const timelineFrame = startFrame + localFrame;
    const frame = motionGraphicV2FrameReceipt(project, graphic, timelineFrame, layout);
    const camera = cameraScope.sample(graphic.id, timelineFrame);
    if (camera.active && !graphic.vectorV2 && !layout.physicalFont) throw new Error("scene2d camera requires a physical glyph layout receipt; estimated text is unsupported");
    const start = assMotionFrameTime(timelineFrame, project.fps);
    const end = assMotionFrameTime(timelineFrame + 1, project.fps);
    if (graphic.vectorV2 && frame.vectorState) {
      const state = frame.vectorState;
      const origin = projectMotionScenePoint({ x: layout.box.x + state.translateXPixels, y: layout.box.y + state.translateYPixels }, camera);
      const x = camera.active ? glyphAssNumber(origin.x) : roundAss(origin.x), y = camera.active ? glyphAssNumber(origin.y) : roundAss(origin.y);
      const scale = camera.active ? glyphAssNumber(state.scale * camera.scale * 100) : roundAss(state.scale * 100);
      for (const path of motionVectorPaths(graphic, layout, frame)) {
        // A wiping shape clips to its uncovered rectangle in screen space.
        let clip = "";
        if (path.clip) {
          const s = state.scale, base = { x: layout.box.x + state.translateXPixels, y: layout.box.y + state.translateYPixels };
          const a = projectMotionScenePoint({ x: base.x + path.clip.x0 * s, y: base.y + path.clip.y0 * s }, camera);
          const b = projectMotionScenePoint({ x: base.x + path.clip.x1 * s, y: base.y + path.clip.y1 * s }, camera);
          clip = `\\clip(${roundAss(a.x)},${roundAss(a.y)},${roundAss(b.x)},${roundAss(b.y)})`;
        }
        const drawing = `{\\an7\\pos(${x},${y})\\p1\\fscx${scale}\\fscy${scale}${clip}\\bord0\\shad0${assOverrideColor(path.color, 1, state.opacity)}}${path.ass}{\\p0}`;
        // Explicit ink annotations paint over glyphs, including lower thirds.
        // Historical vectors keep their original layer and appearance.
        const layer = graphic.vectorV2.schema === "editkin.motion-vector-annotation/v1" ? 3 : 1;
        budget.addLine(`Dialogue: ${layer},${start},${end},Motion,,0,0,0,,${drawing}`);
      }
      continue;
    }
    // Transparent-background typography belongs inside the scene, without a
    // residual panel stroke. Accent still colors the glyph shadow.
    if (frame.backgroundOpacity > .001 && !/^#[0-9a-f]{6}00$/i.test(graphic.backgroundColor)) {
      const box = layout.box;
      const origin = projectMotionScenePoint({ x: box.x, y: box.y }, camera);
      const x = camera.active ? glyphAssNumber(origin.x) : roundAss(origin.x), y = camera.active ? glyphAssNumber(origin.y) : roundAss(origin.y);
      const cameraScale = camera.active ? `\\fscx${glyphAssNumber(camera.scale * 100)}\\fscy${glyphAssNumber(camera.scale * 100)}` : "";
      const drawing = `{\\an7\\pos(${x},${y})\\p1${cameraScale}\\bord0\\shad0${assOverrideColor(graphic.backgroundColor, 1, frame.backgroundOpacity)}}${panel.fillAss}{\\p0}`;
      budget.addLine(`Dialogue: 1,${start},${end},Motion,,0,0,0,,${drawing}`);
      if (panel.borderAss) {
        // CSS border-box strokes occupy the inside edge, not glyph contours.
        budget.addLine(`Dialogue: 1,${start},${end},Motion,,0,0,0,,{\\an7\\pos(${x},${y})\\p1${cameraScale}\\bord0\\shad0${assOverrideColor(graphic.accentColor, 1, frame.backgroundOpacity)}}${panel.borderAss}{\\p0}`);
      }
    }
    for (const state of frame.segments) {
      if (state.opacity <= .001) continue;
      const segment = segmentById.get(state.segmentId)!;
      if (layout.physicalFont) {
        if (!segment.outline) throw new Error(`實體 glyph ${graphic.id} 的輪廓 receipt 不完整`);
        if (!segment.outline.ass) continue;
        const origin = projectMotionScenePoint({ x: segment.x + state.translateXPixels, y: segment.y + state.translateYPixels }, camera);
        const x = glyphAssNumber(origin.x), y = glyphAssNumber(origin.y);
        const scale = glyphAssNumber(state.scale * camera.scale * 100);
        // Motion Language pose: rotate about the scaled segment box center and
        // blur in screen pixels, the same pivot the SVG preview uses.
        const poseTags = (layoutX: number, layoutY: number): string => {
          let tags = "";
          if (state.rotationDegrees) {
            const pivot = projectMotionScenePoint({ x: layoutX + segment.width * state.scale / 2, y: layoutY + segment.height * state.scale / 2 }, camera);
            tags += `\\org(${glyphAssNumber(pivot.x)},${glyphAssNumber(pivot.y)})\\frz${glyphAssNumber(-state.rotationDegrees)}`;
          }
          if (state.blurPixels) tags += `\\blur${glyphAssNumber(state.blurPixels * camera.scale)}`;
          return tags;
        };
        // Contours already carry the true local bearing and baseline. The
        // frame transform uses their local origin; libass must not re-shape
        // text or add the legacy font-size/top-offset approximation.
        if (graphic.shadowDepth) {
          const offset = graphic.shadowDepth * state.scale;
          const shadowOrigin = projectMotionScenePoint({ x: segment.x + state.translateXPixels + offset, y: segment.y + state.translateYPixels + offset }, camera);
          const shadowX = glyphAssNumber(shadowOrigin.x), shadowY = glyphAssNumber(shadowOrigin.y);
          const shadowDrawing = `{\\an7\\q2\\p1\\pos(${shadowX},${shadowY})\\fscx${scale}\\fscy${scale}${poseTags(segment.x + state.translateXPixels + offset, segment.y + state.translateYPixels + offset)}\\bord0\\shad0${assOverrideColor(graphic.accentColor, 1, state.opacity)}}${segment.outline.ass}{\\p0}`;
          budget.addLine(`Dialogue: 2,${start},${end},Motion,,0,0,0,,${shadowDrawing}`);
        }
        const drawing = `{\\an7\\q2\\p1\\pos(${x},${y})\\fscx${scale}\\fscy${scale}${poseTags(segment.x + state.translateXPixels, segment.y + state.translateYPixels)}\\bord0\\shad0${assOverrideColor(graphic.textColor, 1, state.opacity)}}${segment.outline.ass}{\\p0}`;
        budget.addLine(`Dialogue: 2,${start},${end},Motion,,0,0,0,,${drawing}`);
        continue;
      }
      if (!metrics) throw new Error("Legacy Motion 字型度量不完整");
      const x = segment.x + state.translateXPixels;
      const y = segment.y + state.translateYPixels + metrics.topOffset * state.scale;
      const scale = Math.max(1, Math.round(state.scale * 100));
      const legacyPose = (state.rotationDegrees ? `\\org(${roundAss(x + segment.width * state.scale / 2)},${roundAss(segment.y + state.translateYPixels + segment.height * state.scale / 2)})\\frz${roundAss(-state.rotationDegrees)}` : "")
        + (state.blurPixels ? `\\blur${roundAss(state.blurPixels)}` : "");
      const overrides = `{\\an7\\q2${font}${weight}${spacing}\\fs${roundAss(metrics.fontSize)}\\fscx${scale}\\fscy${scale}${legacyPose}${assOverrideColor(graphic.textColor, 1, state.opacity)}${assOverrideColor(graphic.accentColor, 3, state.opacity)}${assOverrideColor(graphic.accentColor, 4, state.opacity)}\\bord0\\shad${shadow}\\pos(${roundAss(x)},${roundAss(y)})}`;
      budget.addLine(`Dialogue: 2,${start},${end},Motion,,0,0,0,,${overrides}${assText(segment.text)}`);
    }
  }
}

function roundAss(value: number): number {
  return Math.round(value * 100) / 100;
}

function glyphAssNumber(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > 1_000_000) throw new Error("實體 glyph frame transform 不合法");
  return Number(value.toFixed(6));
}

export function writeAssContent(project: EditProject, style: CaptionStyle, options: MotionAssOptions = {}): string {
  const bundledFaces = options.bundledFaces !== false;
  const compositeLayer = options.compositeLayer ?? "foreground";
  const budget = admitAssMotionProject(project, style, options);
  const cameraScope = prepareMotionSceneCamera2D(project);
  let renderOptions = options;
  if (project.motionScenes?.length) {
    const sceneLayouts = new Map(options.physicalLayouts);
    const scoped = new Set(project.motionScenes.flatMap(scene => [...scene.graphicIds]));
    for (const graphic of project.motionGraphics) {
      if (!scoped.has(graphic.id)) continue;
      const supplied = sceneLayouts.get(graphic.id);
      if (!graphic.vectorV2 && !supplied?.physicalFont) throw new Error(`scene2d ${graphic.id} requires a physical glyph layout receipt; estimated text is unsupported`);
      sceneLayouts.set(graphic.id, prepareMotionGraphicV2FrameLayout(project, graphic,
        supplied ?? motionGraphicV2LayoutReceipt(project, graphic)));
    }
    // Actual contours (including scaled shadows) must fit throughout the scene
    // before allocating the first output line. No estimated-text fallback.
    assertMotionScenes2DPreparedFrameRange(project, sceneLayouts);
    renderOptions = { ...options, physicalLayouts: sceneLayouts };
  }
  const graphicProject = { ...project, motionGraphics: project.motionGraphics.filter(graphic => (graphic.compositeLayer ?? "foreground") === compositeLayer) };
  const primary = assFace(style.fontFamily, style.bold ? 800 : 400, bundledFaces);
  const secondary = assFace(style.translationFontFamily, style.translationBold ? 800 : 400, bundledFaces);
  const backgroundVisible = /^#[0-9a-f]{6}$/i.test(style.backgroundColor)
    || (/^#[0-9a-f]{8}$/i.test(style.backgroundColor) && style.backgroundColor.slice(7, 9).toUpperCase() !== "00");
  budget.addLine("[Script Info]");
  budget.addLine("ScriptType: v4.00+");
  budget.addLine(`PlayResX: ${project.width}`);
  budget.addLine(`PlayResY: ${project.height}`);
    // These colors are authored as RGB, not legacy video-matched ASS colors.
    // FFmpeg otherwise assumes BT.601 limited: RGB white becomes 235 and
    // black becomes 16; Rec.709 inputs also receive the wrong chroma matrix.
    // None means use the actual compositing input's matrix AND range.
  budget.addLine("YCbCr Matrix: None");
  budget.addLine("WrapStyle: 0");
  budget.addLine("ScaledBorderAndShadow: yes");
  budget.addLine("");
  budget.addLine("[V4+ Styles]");
  budget.addLine("Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding");
    // libass BorderStyle 3 paints the box with OutlineColour. BackColour is
    // the shadow channel, so an opaque outline would make a translucent panel
    // appear solid black even when backgroundColor carries alpha.
  budget.addLine(`Style: Default,${assFontName(primary.fontFamily)},${style.fontSize},${assColor(style.color)},${assColor(style.color)},${assColor(backgroundVisible ? style.backgroundColor : style.outlineColor)},${assColor(style.backgroundColor)},0,${style.italic ? -1 : 0},0,0,100,100,${style.letterSpacing},0,${backgroundVisible ? 3 : 1},${backgroundVisible ? Math.max(8, style.outlineWidth) : style.outlineWidth},${style.shadow},${style.alignment},40,40,${style.marginV},1`);
    // Motion events supply their own panel/outline colors. Subtitle opaque-box
    // styling must never turn an accent outline into a filled glyph rectangle.
  budget.addLine(`Style: Motion,${assFontName(primary.fontFamily)},${style.fontSize},${assColor(style.color)},${assColor(style.color)},${assColor(style.outlineColor)},${assColor(style.backgroundColor)},0,${style.italic ? -1 : 0},0,0,100,100,${style.letterSpacing},0,1,${style.outlineWidth},${style.shadow},${style.alignment},40,40,${style.marginV},1`);
  budget.addLine("");
  budget.addLine("[Events]");
  budget.addLine("Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text");
  for (const caption of compositeLayer === "background" ? [] : project.captions) {
    const translation = caption.translation?.text.trim()
      ? `\\N{\\fn${assFontName(secondary.fontFamily)}\\fs${Math.round(style.translationFontSize)}${assOverrideColor(style.translationColor, 1, 1)}\\b${secondary.fontWeight}\\i${style.translationItalic ? 1 : 0}}${assText(caption.translation.text)}`
      : "";
    budget.addLine(`Dialogue: 0,${assTime(caption.start)},${assTime(caption.start + caption.duration)},Default,,0,0,0,,{\\fn${assFontName(primary.fontFamily)}\\b${primary.fontWeight}}${assText(caption.text)}${translation}`);
  }
  motionGraphicEvents(graphicProject, bundledFaces, renderOptions, budget, cameraScope);
  budget.addLine("");
  return budget.finish();
}

function escapeFilterPath(path: string): string {
  // The filtergraph parser runs before the option-value parser; preserve the
  // latter's escapes through the former. These are FFmpeg escapes, not shell escapes.
  const option = path.replaceAll("\\", "/").replace(/[\\':\s]/g, "\\$&");
  return option.replace(/[\\'\[\],;\s]/g, "\\$&");
}

export function buildAssFilter(assPath: string, fontRoot?: string): string {
  const fonts = fontRoot ? `:fontsdir=${escapeFilterPath(fontRoot)}` : "";
  return `subtitles=filename=${escapeFilterPath(assPath)}${fonts}:wrap_unicode=1`;
}
