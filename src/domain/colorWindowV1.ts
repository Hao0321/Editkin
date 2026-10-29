import type { ClipMask, ColorGradeNodeV2, ColorGradeV2, TimelineClip } from "./types";
import type { SecondaryHslOutsideGradeV1 } from "./secondaryHslV1Types";

/** EG1 extension types until integrator hooks H1/H2 land. Not a second persisted schema. */
export interface ColorWindowNodeFieldsV1 { windowMaskId?: string; windowOutside?: SecondaryHslOutsideGradeV1; }
export type ColorWindowNodeV1 = ColorGradeNodeV2 & ColorWindowNodeFieldsV1;
export type ColorWindowMaskV1 = Omit<ClipMask, "kind"> & {
  purpose?: "alpha" | "color";
  kind: ClipMask["kind"] | "linear_gradient";
};
export type ColorWindowGradeV1 = Omit<ColorGradeV2, "nodes"> & { nodes?: ColorWindowNodeV1[] };
export type ColorWindowClipV1 = Omit<TimelineClip, "masks" | "gradeV2"> & { masks?: ColorWindowMaskV1[]; gradeV2?: ColorWindowGradeV1; };
export type ColorWindowShapeV1 = "rectangle" | "ellipse" | "polygon" | "linear_gradient";
export interface ColorWindowPointV1 { x: number; y: number; }

export const COLOR_WINDOW_LIMITS_V1 = Object.freeze({ spatialNodes: 2, polygonVertices: 16,
  keyframes: 4096, trackPoints: 600_000, rasterBytes: 128 * 1024 ** 2 });
export type ColorWindowRefusalCodeV1 = "COLOR_WINDOW_PURPOSE" | "COLOR_WINDOW_SHAPE" | "COLOR_WINDOW_PATH"
  | "COLOR_WINDOW_REFERENCE" | "COLOR_WINDOW_NODE_LIMIT" | "COLOR_WINDOW_OUTSIDE_WITHOUT_WINDOW"
  | "COLOR_WINDOW_PARAMETERS" | "COLOR_WINDOW_KEYFRAMES" | "COLOR_WINDOW_TRACK" | "COLOR_WINDOW_RASTER_BUDGET";
export class ColorWindowRefusalV1 extends Error {
  constructor(readonly code: ColorWindowRefusalCodeV1, readonly maskId?: string) {
    super(`${code}${maskId ? `: ${maskId}` : ""}`); this.name = "ColorWindowRefusalV1";
  }
}
export const colorWindowRefuseV1 = (code: ColorWindowRefusalCodeV1, maskId?: string): never => { throw new ColorWindowRefusalV1(code, maskId); };
const cross = (a: ColorWindowPointV1, b: ColorWindowPointV1, c: ColorWindowPointV1) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
function intersects(a: ColorWindowPointV1, b: ColorWindowPointV1, c: ColorWindowPointV1, d: ColorWindowPointV1) {
  const on = (p: ColorWindowPointV1, q: ColorWindowPointV1, r: ColorWindowPointV1) => Math.abs(cross(p,q,r)) < 1e-12
    && r.x >= Math.min(p.x,q.x)-1e-12 && r.x <= Math.max(p.x,q.x)+1e-12 && r.y >= Math.min(p.y,q.y)-1e-12 && r.y <= Math.max(p.y,q.y)+1e-12;
  return (cross(a,b,c)*cross(a,b,d) < 0 && cross(c,d,a)*cross(c,d,b) < 0) || on(a,b,c) || on(a,b,d) || on(c,d,a) || on(c,d,b);
}

export function assertColorWindowPathV1(kind: ColorWindowMaskV1["kind"], points: readonly ColorWindowPointV1[], maskId?: string, tracked = false): void {
  if (!Array.isArray(points) || points.some(p => !p || ![p.x,p.y].every(n => Number.isFinite(n) && (tracked ? Math.abs(n)<=32768 : n>=0&&n<=1)))) colorWindowRefuseV1("COLOR_WINDOW_PATH",maskId);
  if (kind === "linear_gradient") {
    if (points.length !== 2 || Math.hypot(points[1].x-points[0].x,points[1].y-points[0].y) < 1e-8) colorWindowRefuseV1("COLOR_WINDOW_PATH",maskId);
    return;
  }
  if (!["rectangle","ellipse","polygon"].includes(kind)) colorWindowRefuseV1("COLOR_WINDOW_SHAPE",maskId);
  if (points.length < 3 || points.length > COLOR_WINDOW_LIMITS_V1.polygonVertices || (kind !== "polygon" && points.length !== 4)) colorWindowRefuseV1("COLOR_WINDOW_PATH",maskId);
  const area = points.reduce((sum,p,i) => { const q=points[(i+1)%points.length]; return sum+p.x*q.y-p.y*q.x; },0);
  if (Math.abs(area) < 1e-10) colorWindowRefuseV1("COLOR_WINDOW_PATH",maskId);
  for (let i=0;i<points.length;i++) {
    const next=(i+1)%points.length;
    if (Math.hypot(points[i].x-points[next].x,points[i].y-points[next].y)<1e-8) colorWindowRefuseV1("COLOR_WINDOW_PATH",maskId);
    for (let j=i+1;j<points.length;j++) if (j!==next && (j+1)%points.length!==i
      && intersects(points[i],points[next],points[j],points[(j+1)%points.length])) colorWindowRefuseV1("COLOR_WINDOW_PATH",maskId);
  }
  if (kind !== "polygon") {
    const signs=points.map((p,i)=>cross(p,points[(i+1)%4],points[(i+2)%4]));
    if (signs.some(n=>Math.abs(n)<1e-12 || Math.sign(n)!==Math.sign(signs[0]))) colorWindowRefuseV1("COLOR_WINDOW_PATH",maskId);
  }
}

/** All authored properties are checked before a raster or a segment bake can start. */
export function assertColorWindowMaskV1(mask: ColorWindowMaskV1): void {
  if (mask.purpose !== "color") colorWindowRefuseV1("COLOR_WINDOW_PURPOSE",mask.id);
  if (typeof mask.id!=="string" || !mask.id.trim() || typeof mask.name!=="string" || !mask.name.trim() || typeof mask.enabled!=="boolean" || typeof mask.inverted!=="boolean"
    || !["add","subtract","intersect"].includes(mask.mode) || !Number.isFinite(mask.opacity) || mask.opacity<0 || mask.opacity>1
    || !Number.isFinite(mask.feather) || mask.feather<0 || mask.feather>.25 || !Number.isFinite(mask.expansion) || Math.abs(mask.expansion)>.5
    || !mask.refine || !Number.isFinite(mask.refine.edgeShift) || Math.abs(mask.refine.edgeShift)>.25
    || ![mask.refine.contrast,mask.refine.chatterReduction].every(n=>Number.isFinite(n)&&n>=0&&n<=1)
    || mask.fixedWindowV3 || mask.matteSequence || mask.frozenRange || mask.rotoCorrections?.length || mask.retiredAutoRotoRecord) colorWindowRefuseV1("COLOR_WINDOW_PARAMETERS",mask.id);
  assertColorWindowPathV1(mask.kind,mask.path,mask.id);
  const ids=mask.path.map(p=>p.id);
  if (new Set(ids).size!==ids.length || ids.some(id=>!id?.trim()) || !Array.isArray(mask.keyframes) || mask.keyframes.length>COLOR_WINDOW_LIMITS_V1.keyframes) colorWindowRefuseV1("COLOR_WINDOW_KEYFRAMES",mask.id);
  let time=-1,frame=-1;
  for (const key of mask.keyframes) {
    if (!Number.isFinite(key.time) || key.time<0 || key.time<=time || !Number.isSafeInteger(key.frame) || key.frame<0 || key.frame<=frame
      || !Number.isFinite(key.confidence) || key.confidence<0 || key.confidence>1 || !["tracked","held","lost","manual"].includes(key.status)
      || !Array.isArray(key.points) || key.points.length!==ids.length || key.points.some((p,i)=>p.id!==ids[i])) colorWindowRefuseV1("COLOR_WINDOW_KEYFRAMES",mask.id);
    assertColorWindowPathV1(mask.kind,key.points,mask.id); time=key.time;frame=key.frame;
  }
}

/** Per-clip references, including bypassed nodes: bypass cannot hide a dangling reference. */
export function assertColorWindowsForClipV1(clip: Pick<ColorWindowClipV1,"id"|"masks"|"gradeV2">): void {
  const masks=clip.masks??[], nodes=clip.gradeV2?.nodes??[];
  for (const mask of masks) {
    if (mask.kind==="linear_gradient" && mask.purpose!=="color") colorWindowRefuseV1("COLOR_WINDOW_PURPOSE",mask.id);
    if (mask.purpose==="color") assertColorWindowMaskV1(mask);
  }
  if (nodes.filter(n=>n.windowMaskId!==undefined).length>COLOR_WINDOW_LIMITS_V1.spatialNodes) colorWindowRefuseV1("COLOR_WINDOW_NODE_LIMIT");
  for (const node of nodes) {
    if (node.windowOutside!==undefined && !node.windowMaskId) colorWindowRefuseV1("COLOR_WINDOW_OUTSIDE_WITHOUT_WINDOW");
    if (node.windowMaskId===undefined) continue;
    const matches=masks.filter(mask=>mask.id===node.windowMaskId);
    if (typeof node.windowMaskId!=="string" || !node.windowMaskId.trim() || matches.length!==1 || matches[0].purpose!=="color" || !matches[0].enabled) colorWindowRefuseV1("COLOR_WINDOW_REFERENCE",node.windowMaskId);
  }
}
export function assertColorWindowsV1(project: { tracks: readonly { clips: readonly Pick<ColorWindowClipV1,"id"|"masks"|"gradeV2">[] }[] }): void {
  for (const track of project.tracks) for (const clip of track.clips) assertColorWindowsForClipV1(clip);
}
/** H3 uses this on the candidate state; creation still dispatches the existing mask+node batch. */
export function assertColorWindowMaskChangeV1(clip: Pick<ColorWindowClipV1,"id"|"masks"|"gradeV2">, id: string, replacement: ColorWindowMaskV1 | null): void {
  assertColorWindowsForClipV1({...clip,masks:(clip.masks??[]).filter(mask=>mask.id!==id).concat(replacement?[replacement]:[])});
}
