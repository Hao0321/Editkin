import { Vector3 } from "three";
import { Mesh3dGeometryCache } from "../motion/mesh3dGeometry";
import { mesh3dProjection } from "../motion/mesh3dRasterizer";
import { mesh3dRayDepthV1 } from "../motion/mesh3dRayDepthV1";
import { mesh3dSceneSchema, type Mesh3dCamera, type Mesh3dScene } from "../motion/mesh3dScene";
import { validatePrevisCameraV1 } from "./cameraPrevisMotionV1";
import { assembleCameraPrevisObjectV1 } from "./cameraPrevisObjectsV1";
import { cameraPrevisObjectDraftSchemaV1, planCameraPrevisObjectEditV1, type CameraPrevisObjectDraftV1 } from "./cameraPrevisObjectEditingV1";

type Point = { x: number; y: number };
type PlacementPlan = ReturnType<typeof planCameraPrevisObjectEditV1>;
function point(p: Point) { if (![p.x, p.y].every(n => Number.isFinite(n) && n >= 0 && n <= 1)) throw Error("PREVIS_POINTER_INVALID"); }
export function prepareCameraPrevisPlacementV1(input: Mesh3dScene, draftInput: CameraPrevisObjectDraftV1, cameraInput: Mesh3dCamera,
  aspect: number, floorY: number, localSeconds = 0, cache = new Mesh3dGeometryCache()) {
  const scene = mesh3dSceneSchema.parse(input), draft = cameraPrevisObjectDraftSchemaV1.parse(draftInput), camera = validatePrevisCameraV1(cameraInput);
  if (!Number.isFinite(aspect) || aspect < .25 || aspect > 4 || !Number.isFinite(floorY) || Math.abs(floorY) > 100) throw Error("PREVIS_PLACEMENT_INVALID");
  const segment = scene.segments.find(s => s.id === draft.segmentId); if (!segment) throw Error("PREVIS_SEGMENT_MISSING");
  if (!Number.isFinite(localSeconds) || localSeconds < 0 || localSeconds > segment.duration) throw Error("PREVIS_TIME_INVALID");
  const projection = mesh3dProjection(camera, aspect), inverse = projection.clone().invert(), groups = new Map<string, string>();
  for (const descriptor of draft.objects) for (const part of assembleCameraPrevisObjectV1(descriptor).objects) {
    if (groups.has(part.id) || JSON.stringify(segment.objects.find(o => o.id === part.id)) !== JSON.stringify(part)) throw Error("PREVIS_OBJECT_GROUP_DETACHED");
    groups.set(part.id, descriptor.id);
  }
  const draws = segment.objects.map(object => ({ object, time: localSeconds, mesh: cache.get(object.geometry) }));
  if (draws.reduce((n, d) => n + d.mesh.indices.length / 3, 0) > 60_000) throw Error("PREVIS_TRIANGLE_BUDGET");
  const rays = draws.map(draw => ({ group: groups.get(draw.object.id) ?? null, depth: mesh3dRayDepthV1(projection, [draw]) }));
  function ground(p: Point): [number, number, number] {
    point(p); const start = new Vector3(p.x * 2 - 1, 1 - p.y * 2, -1).applyMatrix4(inverse);
    const end = new Vector3(p.x * 2 - 1, 1 - p.y * 2, 1).applyMatrix4(inverse), direction = end.sub(start);
    const t = (floorY - start.y) / direction.y;
    if (Math.abs(direction.y) < 1e-9 || !Number.isFinite(t) || t < 0 || t > 1) throw Error("PREVIS_GROUND_NOT_VISIBLE");
    const hit = start.addScaledVector(direction, t);
    if (hit.toArray().some(n => Math.abs(n) > 100)) throw Error("PREVIS_GROUND_OUTSIDE_WORLD");
    return [hit.x, floorY, hit.z];
  }
  function pick(p: Point) {
    point(p); let nearest = Infinity, group: string | null = null;
    for (const ray of rays) { const depth = ray.depth(p.x, p.y); if (depth < nearest) { nearest = depth; group = ray.group; } }
    return group;
  }
  function move(id: string, from: Point, to: Point): PlacementPlan {
    const descriptor = draft.objects.find(d => d.id === id); if (!descriptor) throw Error("PREVIS_OBJECT_MISSING");
    const start = ground(from), end = ground(to);
    return planCameraPrevisObjectEditV1(scene, draft, { kind: "transform", id, rotationDegrees: descriptor.rotationDegrees, scale: descriptor.scale,
      position: descriptor.position.map((n, i) => n + end[i] - start[i]) as [number, number, number] });
  }
  return { pick, ground, move };
}

/** Event binder only. The caller applies a single ordinary scene command on commit. */
export function bindCameraPrevisObjectDragV1(canvas: HTMLCanvasElement, getPlacement: () => ReturnType<typeof prepareCameraPrevisPlacementV1>,
  callbacks: { preview: (plan: PlacementPlan) => void; commit: (plan: PlacementPlan) => void; cancel: () => void; refused: (error: unknown) => void }) {
  let active: { pointer: number; id: string; start: Point; latest: Point; placement: ReturnType<typeof prepareCameraPrevisPlacementV1>; plan?: PlacementPlan } | undefined;
  let raf = 0, disposed = false;
  const previousTouch = canvas.style.touchAction, previousTab = canvas.tabIndex;
  canvas.style.touchAction = "none"; if (canvas.tabIndex < 0) canvas.tabIndex = 0;
  function coordinates(event: PointerEvent): Point {
    const rect = canvas.getBoundingClientRect(); if (rect.width <= 0 || rect.height <= 0) throw Error("PREVIS_VIEWPORT_HIDDEN");
    return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
  }
  function cancel() {
    if (!active) return;
    const pointer = active.pointer; active = undefined; cancelAnimationFrame(raf); raf = 0;
    if (canvas.hasPointerCapture(pointer)) canvas.releasePointerCapture(pointer);
    callbacks.cancel();
  }
  function refuse(error: unknown, restore = cancel) {
    let failure = error;
    try { restore(); } catch (restoreError) { failure = new AggregateError([error, restoreError], "PREVIS_DRAG_RESTORE_FAILED"); }
    callbacks.refused(failure);
  }
  function cancelEvent() { try { cancel(); } catch (error) { callbacks.refused(error); } }
  function update(event: PointerEvent) {
    try { active!.latest = coordinates(event); return true; }
    catch (error) { refuse(error); return false; }
  }
  function flush() {
    raf = 0; if (!active) return;
    try {
      const { start, latest } = active;
      if (Math.hypot(start.x - latest.x, start.y - latest.y) <= 1e-9) {
        if (active.plan) callbacks.preview(active.placement.move(active.id, start, start));
        active.plan = undefined; return;
      }
      active.plan = active.placement.move(active.id, start, latest); callbacks.preview(active.plan);
    } catch (error) { refuse(error); }
  }
  function down(event: PointerEvent) {
    if (disposed || active || event.button !== 0 || !event.isPrimary) return;
    try {
      const p = coordinates(event), placement = getPlacement(), id = placement.pick(p); if (!id) return;
      placement.ground(p); canvas.setPointerCapture(event.pointerId); canvas.focus({ preventScroll: true });
      active = { pointer: event.pointerId, id, start: p, latest: p, placement }; event.preventDefault();
    } catch (error) { callbacks.refused(error); }
  }
  function move(event: PointerEvent) {
    if (!active || active.pointer !== event.pointerId) return;
    if (!update(event)) return; if (!raf) raf = requestAnimationFrame(flush); event.preventDefault();
  }
  function up(event: PointerEvent) {
    if (!active || active.pointer !== event.pointerId) return;
    if (!update(event)) return; cancelAnimationFrame(raf); flush();
    if (!active) return;
    const { plan, pointer } = active; active = undefined;
    try {
      if (canvas.hasPointerCapture(pointer)) canvas.releasePointerCapture(pointer);
      if (plan) callbacks.commit(plan);
    } catch (error) { refuse(error, () => callbacks.cancel()); }
  }
  const pointerCancel = (event: PointerEvent) => { if (active?.pointer === event.pointerId) cancelEvent(); };
  const key = (event: KeyboardEvent) => { if (active && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelEvent(); } };
  canvas.addEventListener("pointerdown", down); canvas.addEventListener("pointermove", move); canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", pointerCancel); canvas.addEventListener("lostpointercapture", pointerCancel); canvas.addEventListener("keydown", key); window.addEventListener("blur", cancelEvent);
  return { cancel, dispose() {
    if (disposed) return; disposed = true;
    try { cancel(); } finally {
      canvas.removeEventListener("pointerdown", down); canvas.removeEventListener("pointermove", move); canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", pointerCancel); canvas.removeEventListener("lostpointercapture", pointerCancel); canvas.removeEventListener("keydown", key); window.removeEventListener("blur", cancelEvent);
      canvas.style.touchAction = previousTouch; canvas.tabIndex = previousTab;
    }
  } };
}
