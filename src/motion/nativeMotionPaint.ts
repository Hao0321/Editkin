import type { EditProject, MotionGraphic } from "../domain/types";
import { assertMotionPaintContract, type MotionPaintDescriptor } from "../domain/motionPaint";
import { canonicalJson } from "../shared/canonicalJson";
import type { PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { motionGraphicV2LayoutReceipt, motionGraphicV2PhysicalLayoutReceipt, prepareMotionGraphicV2FrameLayout, motionGraphicV2FrameReceipt,
  type MotionGraphicV2LayoutReceipt } from "./compositionV2";
import { motionStaticVectorPath } from "./vectorGeometry";
import { assertMotionScene2DGraphicFrameInk, prepareMotionSceneCamera2D } from "./sceneCamera2d";
import type { NativePaint, NativePaintLayer, NativePaintScene, NativeVectorPath, PaintPose } from "./nativeGlyphPaint";

export interface PreparedNativeMotionPaint {
  readonly schema: "editkin.prepared-native-motion-paint/v1";
  readonly graphicIds: readonly string[];
}
interface NativeMotionPaintTrackBase {
  readonly scene: NativePaintScene;
  readonly timeline: Readonly<{ timelineStartFrame: number; sourceStartFrame: 0; durationFrames: number }>;
  /** Row n owns the exact poses at timelineStartFrame + n, in scene layer order. */
  readonly frames: readonly (readonly PaintPose[])[];
  /** Canonical authored equality binding; neither a font receipt nor external authority. */
  readonly sourceSignature: string;
}
export interface NativeMotionPaintTrackV1 extends NativeMotionPaintTrackBase {
  readonly schema: "editkin.native-motion-paint-track/v1";
}
export interface NativeMotionPaintTrackV2 extends NativeMotionPaintTrackBase {
  readonly schema: "editkin.native-motion-paint-track/v2";
  readonly colorIntent: "display_rec709_sdr";
}
export type NativeMotionPaintTrack = NativeMotionPaintTrackV1 | NativeMotionPaintTrackV2;
export const NATIVE_MOTION_PAINT_MAX_POSES = 18_000;
export const NATIVE_MOTION_PAINT_MAX_SOURCE_SIGNATURE_BYTES = 65_536;
type PreparedGraphic = { graphic: MotionGraphic; layout: MotionGraphicV2LayoutReceipt; layers: readonly NativePaintLayer[];
  timeline: NativeMotionPaintTrack["timeline"] };
type PreparedOwner = { signature: string; graphics: readonly PreparedGraphic[]; tracks: Map<string, NativeMotionPaintTrack>; maxScale?: number };
const prepared = new WeakMap<PreparedNativeMotionPaint, PreparedOwner>();
function freezeOwned(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeOwned(child);
  Object.freeze(value);
}
function signature(project: EditProject): string {
  const hasDisplayPaint = project.motionGraphics.some(graphic => graphic.paintV1?.schema === "editkin.motion-paint/v2");
  const source = canonicalJson({ width: project.width, height: project.height, fps: project.fps,
    graphics: project.motionGraphics.filter(graphic => graphic.paintV1), scenes: project.motionScenes ?? [],
    // Preserve the exact historical V1 signature. New display artwork owns its
    // output boundary configuration, so a later output drift invalidates it.
    ...(hasDisplayPaint ? { displayBoundary: project.colorManagement } : {}) });
  if (source.length > NATIVE_MOTION_PAINT_MAX_SOURCE_SIGNATURE_BYTES
    || new TextEncoder().encode(source).length > NATIVE_MOTION_PAINT_MAX_SOURCE_SIGNATURE_BYTES) throw new Error("Native paint authored source signature exceeds bounded size");
  return source;
}
function ownerFor(project: EditProject, handle: PreparedNativeMotionPaint): PreparedOwner {
  const owner = prepared.get(handle);
  if (!owner || owner.signature !== signature(project)) throw new Error("Native paint preparation is stale or not factory-owned");
  return owner;
}
function timelineFor(project: EditProject, graphic: MotionGraphic): NativeMotionPaintTrack["timeline"] {
  const timelineStartFrame = Math.round(graphic.timelineStart * project.fps), durationFrames = Math.round(graphic.duration * project.fps);
  if (!Number.isSafeInteger(timelineStartFrame) || timelineStartFrame < 0 || !Number.isSafeInteger(durationFrames)
    || durationFrames < 1 || !Number.isSafeInteger(timelineStartFrame + durationFrames)) throw new Error("Native paint needs a bounded integer timeline");
  return Object.freeze({ timelineStartFrame, sourceStartFrame: 0, durationFrames });
}
function rgba(hex: string): readonly [number, number, number, number] {
  return [1, 3, 5, 7].map((offset, i) => i === 3 && hex.length === 7 ? 1 : parseInt(hex.slice(offset, offset + 2), 16) / 255) as [number, number, number, number];
}
function layerPaint(paint: MotionPaintDescriptor["fill"], box: MotionGraphicV2LayoutReceipt["box"], offsetX: number, offsetY: number): NativePaint {
  const point = (value: { x: number; y: number }) => ({ x: value.x * box.width - offsetX, y: value.y * box.height - offsetY });
  if (paint.kind === "solid") return { kind: "solid", color: rgba(paint.color) };
  const stops = paint.stops.map(stop => ({ at: stop.at, color: rgba(stop.color) }));
  return paint.kind === "linear" ? { kind: "linear", start: point(paint.start), end: point(paint.end), stops }
    : { kind: "radial", center: point(paint.center), radius: paint.radius * Math.min(box.width, box.height), stops };
}

/** Factory runs compile the existing multiline layout. No saved contours, CSS
 * text, estimated layout, caller font hash or alternate animation evaluator. */
export function prepareNativeMotionPaint(project: EditProject, runs: ReadonlyMap<string, PreparedGlyphRun>): PreparedNativeMotionPaint {
  if (!Number.isSafeInteger(project.width) || !Number.isSafeInteger(project.height) || project.width < 1 || project.height < 1
    || project.width > 8192 || project.height > 8192 || project.width * project.height > 8294400) throw new Error("Native paint canvas exceeds bounded dimensions");
  const graphics: PreparedGraphic[] = [];
  const sourceSignature = signature(project), ids = new Set<string>();
  let commands = 0, layers = 0, poses = 0;
  for (const current of project.motionGraphics) {
    if (ids.has(current.id)) throw new Error("Native paint project has duplicate graphic identity");
    ids.add(current.id);
    assertMotionPaintContract(current);
    if (!current.paintV1) continue;
    if (current.paintV1.schema === "editkin.motion-paint/v2" && (project.colorManagement?.mode !== "aces2"
      || project.colorManagement.outputTransform !== "rec709_sdr" || project.scene3d?.enabled || project.scene25d?.enabled)) {
      throw new Error("Display Rec.709 native paint requires an explicit ACES2 rec709_sdr 2D project");
    }
    const run = runs.get(current.id);
    if (!current.vectorV2 && !run) throw new Error(`Native paint ${current.id} requires an actual physical glyph factory run`);
    const graphic = structuredClone(current);
    const timeline = timelineFor(project, graphic);
    const layout = prepareMotionGraphicV2FrameLayout(project, graphic, graphic.vectorV2
      ? motionGraphicV2LayoutReceipt(project, graphic) : motionGraphicV2PhysicalLayoutReceipt(project, graphic, run!));
    const compiled: NativePaintLayer[] = [];
    const segments = graphic.vectorV2 ? [{ id: `${graphic.id}:vector`, x: layout.box.x, y: layout.box.y,
      outline: { commands: motionStaticVectorPath(graphic, layout).commands } }] : layout.segments;
    for (const segment of segments) {
      if (!segment.outline?.commands.length) continue;
      const offsetX = segment.x - layout.box.x, offsetY = segment.y - layout.box.y;
      const clips: NativeVectorPath[] = graphic.paintV1!.clips.map(clip => ({ fill_rule: clip.fillRule,
        commands: clip.commands.map(command => {
          const point = (x: number, y: number) => ({ x: x * layout.box.width - offsetX, y: y * layout.box.height - offsetY });
          if (command.type === "Z") return { type: "Z" };
          if (command.type === "M" || command.type === "L") return { type: command.type, ...point(command.x, command.y) };
          const a = point(command.x1, command.y1);
          return command.type === "Q" ? { type: "Q", x1: a.x, y1: a.y, ...point(command.x, command.y) }
            : { type: "C", x1: a.x, y1: a.y, x2: point(command.x2, command.y2).x, y2: point(command.x2, command.y2).y, ...point(command.x, command.y) };
        }) }));
      commands += segment.outline.commands.length + clips.reduce((total, clip) => total + clip.commands.length, 0);
      if (++layers > 64 || commands > 65536) throw new Error("Native paint composition exceeds shared layer/command budget");
      const { stroke, shadow } = graphic.paintV1!;
      compiled.push({ id: segment.id, path: { commands: segment.outline.commands, fill_rule: "non_zero" },
        paint: layerPaint(graphic.paintV1!.fill, layout.box, offsetX, offsetY), clips,
        ...(stroke ? { stroke: { width: stroke.widthPixels, color: rgba(stroke.color) } } : {}),
        ...(shadow ? { shadow: { offset_x: shadow.offsetXPixels, offset_y: shadow.offsetYPixels,
          blur: shadow.blurPixels, color: rgba(shadow.color) } } : {}) });
    }
    poses += timeline.durationFrames * compiled.length;
    if (!Number.isSafeInteger(poses) || poses > NATIVE_MOTION_PAINT_MAX_POSES) throw new Error("Native paint composition exceeds shared 18,000 pose budget");
    freezeOwned(graphic); freezeOwned(compiled);
    graphics.push({ graphic, layout, layers: compiled, timeline });
  }
  const handle: PreparedNativeMotionPaint = Object.freeze({ schema: "editkin.prepared-native-motion-paint/v1", graphicIds: Object.freeze(graphics.map(item => item.graphic.id)) });
  prepared.set(handle, { signature: sourceSignature, graphics, tracks: new Map() });
  return handle;
}

function graphicPoses(project: EditProject, item: PreparedGraphic, camera: ReturnType<typeof prepareMotionSceneCamera2D>,
  timelineFrame: number): readonly PaintPose[] | undefined {
  const { graphic, layout } = item;
  const frame = motionGraphicV2FrameReceipt(project, graphic, timelineFrame, layout);
  if (!frame.visible) return undefined;
  const projection = camera.sample(graphic.id, timelineFrame);
  assertMotionScene2DGraphicFrameInk(project, graphic, layout, frame, projection);
  const states = new Map(frame.segments.map(state => [state.segmentId, state]));
  return item.layers.map(layer => {
    const state = graphic.vectorV2 ? frame.vectorState : states.get(layer.id);
    const segment = graphic.vectorV2 ? layout.box : layout.segments.find(segment => segment.id === layer.id);
    if (!state || !segment) throw new Error("Native paint needs the same physical segment frame");
    const scale = state.scale * projection.scale;
    const x = (segment.x + state.translateXPixels) * projection.scale + projection.translateX;
    const y = (segment.y + state.translateYPixels) * projection.scale + projection.translateY;
    if (![x, y, scale, state.opacity].every(Number.isFinite) || Math.abs(x) > 1_000_000 || Math.abs(y) > 1_000_000
      || scale < .01 || scale > 32 || state.opacity < 0 || state.opacity > 1) throw new Error("Native paint segment/camera pose exceeds native bounds");
    return Object.freeze({ x, y, scale, opacity: state.opacity });
  });
}

/** Transportable track bytes are emitted only from this private factory handle.
 * Keep every segment at every integer frame; entry opacity never changes node
 * membership, and repeated graph preparation reuses the same frozen track. */
export function nativeMotionPaintTrack(project: EditProject, handle: PreparedNativeMotionPaint, graphicId: string): NativeMotionPaintTrack {
  const owner = ownerFor(project, handle), item = owner.graphics.find(value => value.graphic.id === graphicId);
  if (!item) throw new Error(`Native paint ${graphicId} is missing from actual preparation`);
  prepareTracks(project, owner);
  return owner.tracks.get(graphicId)!;
}

/** Compile every already-bounded integer pose before choosing curve tolerance.
 * A shared bound keeps frame, preview and export tessellation identical. The
 * legal 32x ceiling remains enforced by graphicPoses; it is not a request to
 * flatten every normally-sized curve at 32x resolution. */
function prepareTracks(project: EditProject, owner: PreparedOwner): void {
  if (owner.maxScale !== undefined) return;
  const camera = prepareMotionSceneCamera2D(project), rows: Array<{ item: PreparedGraphic; frames: Array<readonly PaintPose[]> }> = [];
  let maxScale = 1;
  for (const item of owner.graphics) {
    const frames: Array<readonly PaintPose[]> = [];
    for (let localFrame = 0; localFrame < item.timeline.durationFrames; localFrame++) {
      const poses = graphicPoses(project, item, camera, item.timeline.timelineStartFrame + localFrame);
      if (!poses || poses.length !== item.layers.length) throw new Error("Native paint track lost a physical layer or active timeline frame");
      for (const pose of poses) maxScale = Math.max(maxScale, pose.scale);
      frames.push(Object.freeze(poses));
    }
    rows.push({ item, frames });
  }
  // Do not cache any partial preparation if a later graphic/pose is invalid.
  for (const { item, frames } of rows) {
    const track: NativeMotionPaintTrack = { ...(item.graphic.paintV1!.schema === "editkin.motion-paint/v2"
      ? { schema: "editkin.native-motion-paint-track/v2" as const, colorIntent: "display_rec709_sdr" as const }
      : { schema: "editkin.native-motion-paint-track/v1" as const }),
      scene: { width: project.width, height: project.height, max_scale: maxScale, background: [0, 0, 0, 0], layers: item.layers },
      timeline: item.timeline, frames, sourceSignature: owner.signature };
    freezeOwned(track); owner.tracks.set(item.graphic.id, track);
  }
  owner.maxScale = maxScale;
}

/** One paint overlay frame for the current native consumer. This does not render
 * a project or bypass v4. Array order and bakedIds belong to the caller's graph. */
export function nativeMotionPaintFrame(project: EditProject, handle: PreparedNativeMotionPaint, timelineFrame: number): {
  scene: NativePaintScene; poses: readonly PaintPose[]; bakedIds: readonly string[]; colorIntent?: "display_rec709_sdr";
} {
  const owner = ownerFor(project, handle);
  const intents = new Set(owner.graphics.map(item => item.graphic.paintV1!.schema));
  if (intents.size > 1) throw new Error("Native paint frame cannot flatten scene and display color intents; keep individual ordered tracks");
  if (!Number.isSafeInteger(timelineFrame) || timelineFrame < 0) throw new Error("Native paint needs an integer project frame");
  prepareTracks(project, owner);
  const camera = prepareMotionSceneCamera2D(project), layers: NativePaintLayer[] = [], poses: PaintPose[] = [];
  for (const item of owner.graphics) {
    const sample = graphicPoses(project, item, camera, timelineFrame);
    if (!sample) continue;
    layers.push(...item.layers); poses.push(...sample);
  }
  return { scene: { width: project.width, height: project.height, max_scale: owner.maxScale, background: [0, 0, 0, 0], layers },
    poses, bakedIds: handle.graphicIds,
    ...(intents.has("editkin.motion-paint/v2") ? { colorIntent: "display_rec709_sdr" as const } : {}) };
}
