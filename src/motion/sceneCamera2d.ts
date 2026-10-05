import type { EditProject, MotionGraphic } from "../domain/types";
import { assertMotionPaintContract } from "../domain/motionPaint";
import { assertMotionScene2D, assertMotionScenes2D, MOTION_SCENE_2D_LIMITS,
  type MotionScene2D, type MotionScene2DProject } from "../domain/motionScene2d";
import { canonicalJson } from "../shared/canonicalJson";
import { sampleSpringTargetTrack } from "./springTargetTrack";
import { motionGraphicV2FrameReceipt, prepareMotionGraphicV2FrameLayout, type MotionGraphicV2LayoutReceipt, type MotionGraphicV2FrameReceipt } from "./compositionV2";
import { motionVectorPaths } from "./vectorGeometry";
import { motionPanelPaths } from "./panelGeometry";

export interface MotionScenePoint { x: number; y: number }
export interface MotionSceneInk { xMin: number; yMin: number; xMax: number; yMax: number }
export interface MotionSceneCamera2DProjection {
  sceneId?: string;
  active: boolean;
  scale: number;
  translateX: number;
  translateY: number;
  /** Derivatives per second, using the same retained oscillator velocity. */
  velocity: { scale: number; translateX: number; translateY: number };
}
export interface PreparedMotionSceneCamera2D {
  /** Canonical source equality binding, not a cryptographic authorization. */
  readonly sourceSignature: string;
  sample(graphicId: string, timelineFrame: number): MotionSceneCamera2DProjection;
}
export interface MotionScene2DSafetyReceipt {
  schema: "editkin.motion-scene-2d-safety/v1";
  sceneId: string;
  cameraSourceSignature: string;
  framesChecked: number;
  graphicFramesChecked: number;
  layoutReceiptIds: Readonly<Record<string, string>>;
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) throw new Error(`Motion scene ${label} must be finite within the safe numeric range`);
  return value === 0 ? 0 : value;
}

function freezeOwned(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const child of Object.values(value)) freezeOwned(child);
  Object.freeze(value);
}

function signature(project: MotionScene2DProject): string {
  const scenes = project.motionScenes ?? [], scoped = new Set(scenes.flatMap(scene => [...scene.graphicIds]));
  return canonicalJson({ width: project.width, height: project.height, fps: project.fps, scenes,
    graphics: project.motionGraphics.filter(graphic => scoped.has(graphic.id)).map(graphic => ({ id: graphic.id,
      schema: graphic.schema, timelineStart: graphic.timelineStart, duration: graphic.duration,
      compositeLayer: graphic.compositeLayer, trackId: graphic.trackId, trackingMode: graphic.trackingMode,
      vector: !!graphic.vectorV2 })) });
}

function identity(): MotionSceneCamera2DProjection {
  return Object.freeze({ active: false, scale: 1, translateX: 0, translateY: 0,
    velocity: Object.freeze({ scale: 0, translateX: 0, translateY: 0 }) });
}

function sameSourceData(current: unknown, owned: unknown): boolean {
  if (!owned || typeof owned !== "object") return Object.is(current, owned);
  if (!current || typeof current !== "object") return false;
  const array = Array.isArray(owned);
  if (Array.isArray(current) !== array) return false;
  const prototype = Object.getPrototypeOf(current);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false;
  if (array && (current as unknown[]).length !== (owned as unknown[]).length) return false;
  const expectedKeys = Reflect.ownKeys(owned), keys = Reflect.ownKeys(current);
  if (keys.length !== expectedKeys.length) return false;
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (!descriptor || !("value" in descriptor) || !sameSourceData(descriptor.value, Reflect.get(owned, key))) return false;
  }
  return true;
}

function sceneProjection(project: Pick<MotionScene2DProject, "width" | "height">,
  scene: MotionScene2D, timelineFrame: number): MotionSceneCamera2DProjection {
  const frame = timelineFrame - scene.startFrame;
  const x = sampleSpringTargetTrack(scene.camera.centerX, frame), y = sampleSpringTargetTrack(scene.camera.centerY, frame);
  const zoom = sampleSpringTargetTrack(scene.camera.zoom, frame);
  if (zoom.position < MOTION_SCENE_2D_LIMITS.minZoom || zoom.position > MOTION_SCENE_2D_LIMITS.maxZoom) throw new Error(`Motion scene ${scene.id} zoom overshoot exceeds its positive supported range at frame ${frame}`);
  const scale = finite(zoom.position, "sample scale");
  return Object.freeze({ sceneId: scene.id, active: true, scale,
    translateX: finite(project.width / 2 - scale * x.position, "sample translateX"),
    translateY: finite(project.height / 2 - scale * y.position, "sample translateY"),
    velocity: Object.freeze({ scale: finite(zoom.velocity, "sample scale velocity"),
      translateX: finite(-zoom.velocity * x.position - scale * x.velocity, "sample translateX velocity"),
      translateY: finite(-zoom.velocity * y.position - scale * y.velocity, "sample translateY velocity") }) });
}

/** Own scenes once. No whole-frame preflight or glyph serialization in sample. */
export function prepareMotionSceneCamera2D(project: MotionScene2DProject): PreparedMotionSceneCamera2D {
  assertMotionScenes2D(project);
  const sourceSignature = signature(project), scenes = structuredClone(project.motionScenes ?? []);
  freezeOwned(scenes);
  const width = project.width, height = project.height, fps = project.fps, graphicCount = project.motionGraphics.length;
  const scopedIds = new Set(scenes.flatMap(scene => [...scene.graphicIds]));
  const bindings = project.motionGraphics.flatMap((graphic, index) => scopedIds.has(graphic.id) ? [{ index, id: graphic.id,
    schema: graphic.schema, timelineStart: graphic.timelineStart, duration: graphic.duration, compositeLayer: graphic.compositeLayer,
    trackId: graphic.trackId, trackingMode: graphic.trackingMode, vector: !!graphic.vectorV2 }] : []);
  freezeOwned(bindings);
  const sceneByGraphic = new Map<string, MotionScene2D[]>();
  for (const scene of scenes) for (const id of scene.graphicIds) {
    const membership = sceneByGraphic.get(id) ?? [];
    membership.push(scene); sceneByGraphic.set(id, membership);
  }
  const unchanged = () => {
    if (project.width !== width || project.height !== height || project.fps !== fps || project.motionGraphics.length !== graphicCount
      || !sameSourceData(project.motionScenes ?? [], scenes)) return false;
    for (const binding of bindings) {
      const graphic = project.motionGraphics[binding.index];
      if (!graphic || graphic.id !== binding.id || graphic.schema !== binding.schema || graphic.timelineStart !== binding.timelineStart
        || graphic.duration !== binding.duration || graphic.compositeLayer !== binding.compositeLayer || graphic.trackId !== binding.trackId
        || graphic.trackingMode !== binding.trackingMode || !!graphic.vectorV2 !== binding.vector) return false;
    }
    return true;
  };
  const resolver: PreparedMotionSceneCamera2D = { sourceSignature, sample(graphicId, timelineFrame) {
    if (typeof graphicId !== "string" || !graphicId || !Number.isSafeInteger(timelineFrame)) throw new Error("Motion scene sampler requires a graphic identity and integer timeline frame");
    if (!unchanged()) throw new Error("Prepared motion scene camera source changed; prepare the current scene again");
    let active: MotionScene2D | undefined;
    for (const scene of sceneByGraphic.get(graphicId) ?? []) {
      if (timelineFrame < scene.startFrame || timelineFrame >= scene.startFrame + scene.durationFrames) continue;
      if (active) throw new Error("Motion scene camera has overlapping graphic ownership");
      active = scene;
    }
    return active ? sceneProjection({ width, height }, active, timelineFrame) : identity();
  } };
  return Object.freeze(resolver);
}

export function sampleMotionSceneCamera2D(project: MotionScene2DProject, graphicId: string, timelineFrame: number): MotionSceneCamera2DProjection {
  return prepareMotionSceneCamera2D(project).sample(graphicId, timelineFrame);
}

/** screen = canvasCenter + zoom * (world - cameraCenter), through one affine map. */
export function projectMotionScenePoint(point: MotionScenePoint, projection: MotionSceneCamera2DProjection): MotionScenePoint {
  if (!point || !projection || !Number.isFinite(projection.scale) || projection.scale <= 0) throw new Error("Motion scene projection requires a positive finite scale and point");
  return Object.freeze({ x: finite(finite(point.x, "point.x") * projection.scale + finite(projection.translateX, "projection.translateX"), "projected point.x"),
    y: finite(finite(point.y, "point.y") * projection.scale + finite(projection.translateY, "projection.translateY"), "projected point.y") });
}

export function projectMotionSceneInk(ink: MotionSceneInk, projection: MotionSceneCamera2DProjection): MotionSceneInk {
  assertInk(ink);
  const minimum = projectMotionScenePoint({ x: ink.xMin, y: ink.yMin }, projection), maximum = projectMotionScenePoint({ x: ink.xMax, y: ink.yMax }, projection);
  return Object.freeze({ xMin: minimum.x, yMin: minimum.y, xMax: maximum.x, yMax: maximum.y });
}

function assertInk(ink: MotionSceneInk): void {
  if (!ink || ![ink.xMin, ink.yMin, ink.xMax, ink.yMax].every(value => Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER)
    || ink.xMin > ink.xMax || ink.yMin > ink.yMax) throw new Error("Motion scene contour requires finite ordered ink bounds");
}

function transformedInk(ink: MotionSceneInk, origin: MotionScenePoint, scale: number): MotionSceneInk {
  assertInk(ink);
  if (!Number.isFinite(scale) || scale <= 0) throw new Error("Motion scene graphic scale must remain positive");
  const result = { xMin: origin.x + ink.xMin * scale, yMin: origin.y + ink.yMin * scale,
    xMax: origin.x + ink.xMax * scale, yMax: origin.y + ink.yMax * scale };
  assertInk(result); return result;
}

function cubicAt(a: number, b: number, c: number, d: number, t: number): number {
  const inverse = 1 - t;
  return inverse * inverse * inverse * a + 3 * inverse * inverse * t * b + 3 * inverse * t * t * c + t * t * t * d;
}

function cubicExtrema(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = -p0 + 3 * p1 - 3 * p2 + p3, b = 2 * (p0 - 2 * p1 + p2), c = p1 - p0;
  if (a === 0) return b === 0 ? [] : [-c / b].filter(t => t > 0 && t < 1);
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return [];
  const root = Math.sqrt(discriminant), q = -.5 * (b + (b >= 0 ? root : -root));
  return (q === 0 ? [-b / (2 * a)] : [q / a, c / q]).filter(t => t > 0 && t < 1);
}

/** Actual generated M/L/C/Z contour extrema, not its control-point rectangle. */
export function motionSceneContourInk(path: string): MotionSceneInk | undefined {
  if (!path) return undefined;
  if (path.length > 2 * 1024 * 1024) throw new Error("Motion scene vector path exceeds its bounded contour input");
  const pattern = /[MLCZ]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
  const tokens = path.match(pattern) ?? [];
  if (tokens.length > 65_536 || path.replace(pattern, "").replace(/[\s,]/g, "")) throw new Error("Motion scene vector path has unsupported or excessive contour commands");
  let current: MotionScenePoint | undefined, start: MotionScenePoint | undefined, index = 0;
  const bounds = { xMin: Infinity, yMin: Infinity, xMax: -Infinity, yMax: -Infinity };
  const add = (point: MotionScenePoint) => {
    finite(point.x, "contour.x"); finite(point.y, "contour.y");
    bounds.xMin = Math.min(bounds.xMin, point.x); bounds.yMin = Math.min(bounds.yMin, point.y);
    bounds.xMax = Math.max(bounds.xMax, point.x); bounds.yMax = Math.max(bounds.yMax, point.y);
  };
  const number = () => {
    const token = tokens[index++];
    if (token === undefined || /^[MLCZ]$/.test(token)) throw new Error("Motion scene vector contour has incomplete coordinates");
    return finite(Number(token), "contour coordinate");
  };
  while (index < tokens.length) {
    const command = tokens[index++];
    if (command === "Z") {
      if (!current || !start) throw new Error("Motion scene contour closure lacks a start");
      add(start); current = undefined; start = undefined; continue;
    }
    if (command === "M") {
      if (current) throw new Error("Motion scene contour must close before a new start");
      current = { x: number(), y: number() }; start = current; add(current); continue;
    }
    if (!current || !start || (command !== "L" && command !== "C")) throw new Error("Motion scene contour requires supported absolute commands");
    do {
      if (command === "L") { current = { x: number(), y: number() }; add(current); }
      else {
        const a = current, b = { x: number(), y: number() }, c = { x: number(), y: number() }, d = { x: number(), y: number() };
        add(d);
        for (const t of [...cubicExtrema(a.x, b.x, c.x, d.x), ...cubicExtrema(a.y, b.y, c.y, d.y)]) {
          add({ x: cubicAt(a.x, b.x, c.x, d.x, t), y: cubicAt(a.y, b.y, c.y, d.y, t) });
        }
        current = d;
      }
    } while (index < tokens.length && !/^[MLCZ]$/.test(tokens[index]));
  }
  if (current) throw new Error("Motion scene contour must be closed");
  if (bounds.xMin === Infinity) return undefined;
  assertInk(bounds); return Object.freeze(bounds);
}

function colorVisible(value: string): boolean { return !/^#[0-9a-f]{6}00$/i.test(value); }

function assertSafe(scene: MotionScene2D, project: MotionScene2DProject, world: MotionSceneInk,
  projection: MotionSceneCamera2DProjection, graphicId: string, frame: number): void {
  assertScreenSafe(scene, project, projectMotionSceneInk(world, projection), graphicId, frame);
}
function assertScreenSafe(scene: MotionScene2D, project: MotionScene2DProject, ink: MotionSceneInk, graphicId: string, frame: number): void {
  const safe = scene.safeArea;
  if (ink.xMin < safe.left || ink.yMin < safe.top || ink.xMax > project.width - safe.right || ink.yMax > project.height - safe.bottom) {
    throw new Error(`Motion scene ${scene.id} actual ink/contour for ${graphicId} exceeds safe-area at frame ${frame}`);
  }
}

/** Native paint does not use legacy text/panel colors. Include round stroke,
 * pixel antialias support and the actual finite Gaussian shadow support after
 * both transforms. Clips may shrink these conservative bounds, never expand them. */
function assertNativePaintInk(project: MotionScene2DProject, scene: MotionScene2D, graphic: MotionGraphic,
  ink: MotionSceneInk, origin: MotionScenePoint, scale: number, projection: MotionSceneCamera2DProjection, frame: number): void {
  assertMotionPaintContract(graphic);
  const paint = graphic.paintV1!, fillVisible = paint.fill.kind === "solid" ? colorVisible(paint.fill.color)
    : paint.fill.stops.some(stop => colorVisible(stop.color));
  const strokeVisible = paint.stroke && colorVisible(paint.stroke.color);
  if (!fillVisible && !strokeVisible) return;
  const projected = projectMotionSceneInk(transformedInk(ink, origin, scale), projection), totalScale = scale * projection.scale;
  const expand = (box: MotionSceneInk, radius: number): MotionSceneInk => ({ xMin: box.xMin - radius,
    yMin: box.yMin - radius, xMax: box.xMax + radius, yMax: box.yMax + radius });
  const caster = expand(projected, strokeVisible ? paint.stroke!.widthPixels * totalScale / 2 : 0);
  assertScreenSafe(scene, project, expand(caster, 1), graphic.id, frame);
  if (paint.shadow && colorVisible(paint.shadow.color)) {
    const { offsetXPixels, offsetYPixels, blurPixels } = paint.shadow;
    const offset = { xMin: caster.xMin + offsetXPixels * totalScale, xMax: caster.xMax + offsetXPixels * totalScale,
      yMin: caster.yMin + offsetYPixels * totalScale, yMax: caster.yMax + offsetYPixels * totalScale };
    assertScreenSafe(scene, project, expand(offset, Math.ceil(3 * blurPixels * totalScale) + 1), graphic.id, frame);
  }
}

function assertGraphicFrameInk(project: EditProject & MotionScene2DProject, scene: MotionScene2D,
  graphic: MotionGraphic, layout: MotionGraphicV2LayoutReceipt, frame: MotionGraphicV2FrameReceipt,
  projection: MotionSceneCamera2DProjection): void {
  if (!frame.visible) return;
  const id = graphic.id, timelineFrame = frame.timelineFrame;
  if (graphic.vectorV2 && frame.vectorState) {
    const state = frame.vectorState, origin = { x: layout.box.x + state.translateXPixels, y: layout.box.y + state.translateYPixels };
    if (state.opacity <= .001) return;
    if (graphic.paintV1) {
      assertNativePaintInk(project, scene, graphic, { xMin: 0, yMin: 0, xMax: layout.box.width, yMax: layout.box.height },
        origin, state.scale, projection, timelineFrame);
      return;
    }
    for (const path of motionVectorPaths(graphic, layout, frame)) {
      if (!colorVisible(path.color)) continue;
      const ink = motionSceneContourInk(path.svg);
      if (ink) assertSafe(scene, project, transformedInk(ink, origin, state.scale), projection, id, timelineFrame);
    }
    return;
  }
  if (!layout.physicalFont || layout.segments.some(segment => !segment.outline)) throw new Error(`Motion scene ${id} requires complete physical glyph contours`);
  if (frame.backgroundOpacity > .001 && colorVisible(graphic.backgroundColor)) {
    const panel = motionPanelPaths(layout.box.width, layout.box.height, graphic.cornerRadius ?? 10, graphic.outlineWidth ?? 2);
    const ink = motionSceneContourInk(panel.fillSvg);
    if (ink) assertSafe(scene, project, transformedInk(ink, { x: layout.box.x, y: layout.box.y }, 1), projection, id, timelineFrame);
  }
  const states = new Map(frame.segments.map(state => [state.segmentId, state]));
  for (const segment of layout.segments) {
    const state = states.get(segment.id), ink = segment.outline?.ink;
    if (!state) throw new Error("Motion scene glyph frame has a missing segment identity");
    if (!ink || state.opacity <= .001) continue;
    const origin = { x: segment.x + state.translateXPixels, y: segment.y + state.translateYPixels };
    if (graphic.paintV1) {
      assertNativePaintInk(project, scene, graphic, ink, origin, state.scale, projection, timelineFrame);
      continue;
    }
    if (colorVisible(graphic.textColor)) assertSafe(scene, project, transformedInk(ink, origin, state.scale), projection, id, timelineFrame);
    if (graphic.shadowDepth && colorVisible(graphic.accentColor)) {
      const offset = graphic.shadowDepth * state.scale;
      assertSafe(scene, project, transformedInk(ink, { x: origin.x + offset, y: origin.y + offset }, state.scale), projection, id, timelineFrame);
    }
  }
}

/** Current UI frame only. This does not claim full-range/whole-scene acceptance. */
export function assertMotionScene2DGraphicFrameInk(project: EditProject & MotionScene2DProject, graphic: MotionGraphic,
  layout: MotionGraphicV2LayoutReceipt, frame: MotionGraphicV2FrameReceipt, projection: MotionSceneCamera2DProjection): void {
  const matching = (project.motionScenes ?? []).filter(scene => scene.graphicIds.includes(graphic.id)
    && frame.timelineFrame >= scene.startFrame && frame.timelineFrame < scene.startFrame + scene.durationFrames);
  if (!matching.length) {
    if (projection.active) throw new Error("Motion scene ink projection is active outside the authored scene");
    return;
  }
  if (matching.length !== 1) throw new Error("Motion scene ink guard has overlapping graphic ownership");
  const scene = matching[0], expectedProjection = sceneProjection(project, scene, frame.timelineFrame);
  if (canonicalJson(expectedProjection) !== canonicalJson(projection)) throw new Error("Motion scene ink projection does not match its current camera frame");
  const prepared = prepareMotionGraphicV2FrameLayout(project, graphic, layout);
  const expectedFrame = motionGraphicV2FrameReceipt(project, graphic, frame.timelineFrame, prepared);
  if (canonicalJson(expectedFrame) !== canonicalJson(frame)) throw new Error("Motion scene ink graphic frame does not match its source/layout");
  assertGraphicFrameInk(project, scene, graphic, prepared, frame, projection);
}

function assertPreparedScene(project: EditProject & MotionScene2DProject, scene: MotionScene2D,
  layouts: ReadonlyMap<string, MotionGraphicV2LayoutReceipt>, camera: PreparedMotionSceneCamera2D): MotionScene2DSafetyReceipt {
  const graphics = new Map<string, { graphic: MotionGraphic; layout: MotionGraphicV2LayoutReceipt }>();
  const layoutReceiptIds: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const id of scene.graphicIds) {
    const graphic = project.motionGraphics.find(item => item.id === id)!;
    const supplied = layouts.get(id);
    if (!supplied || (!graphic.vectorV2 && !supplied.physicalFont)) throw new Error(`Motion scene ${id} requires a current vector or physical glyph layout receipt`);
    const layout = prepareMotionGraphicV2FrameLayout(project, graphic, supplied);
    if (!graphic.vectorV2 && layout.segments.some(segment => !segment.outline)) throw new Error(`Motion scene ${id} physical glyph contours are incomplete`);
    graphics.set(id, { graphic, layout }); layoutReceiptIds[id] = layout.receiptId;
  }
  let graphicFramesChecked = 0;
  for (let localFrame = 0; localFrame < scene.durationFrames; localFrame++) {
    const timelineFrame = scene.startFrame + localFrame;
    for (const [id, { graphic, layout }] of graphics) {
      const projection = camera.sample(id, timelineFrame), frame = motionGraphicV2FrameReceipt(project, graphic, timelineFrame, layout);
      graphicFramesChecked++;
      assertGraphicFrameInk(project, scene, graphic, layout, frame, projection);
    }
  }
  const receipt: MotionScene2DSafetyReceipt = { schema: "editkin.motion-scene-2d-safety/v1", sceneId: scene.id,
    cameraSourceSignature: camera.sourceSignature, framesChecked: scene.durationFrames, graphicFramesChecked, layoutReceiptIds };
  freezeOwned(receipt); return receipt;
}

/** Actual physical layouts are required only here, after byte/font preparation. */
export function assertMotionScene2DPreparedFrameRange(project: EditProject & MotionScene2DProject, scene: MotionScene2D,
  layouts: ReadonlyMap<string, MotionGraphicV2LayoutReceipt>): MotionScene2DSafetyReceipt {
  assertMotionScene2D(scene, project);
  const ownedProject = { ...project, motionScenes: (project.motionScenes ?? []).some(item => item.id === scene.id)
    ? (project.motionScenes ?? []).map(item => item.id === scene.id ? scene : item) : [...(project.motionScenes ?? []), scene] };
  const camera = prepareMotionSceneCamera2D(ownedProject);
  return assertPreparedScene(ownedProject, scene, layouts, camera);
}

export function assertMotionScenes2DPreparedFrameRange(project: EditProject & MotionScene2DProject,
  layouts: ReadonlyMap<string, MotionGraphicV2LayoutReceipt>): readonly MotionScene2DSafetyReceipt[] {
  const camera = prepareMotionSceneCamera2D(project);
  const receipts = (project.motionScenes ?? []).map(scene => assertPreparedScene(project, scene, layouts, camera));
  freezeOwned(receipts); return receipts;
}
