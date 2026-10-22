import { assertColorGradeV2, COLOR_GRADE_V2_MAX_NODES, COLOR_GRADE_V2_MAX_CURVE_POINTS } from "./colorGradeV2Schema";
import type { ColorCurvePointV2, ColorGradeNodeV2, ColorGradeV2, ColorWheelV2 } from "./visualTypes";
import { buildMonotoneCurve, evaluateMonotoneCurve } from "../color/gradeV2Color";

export type GradeWheelKindV1 = "offset" | "lift" | "gamma" | "gain";
export type GradeCurveChannelV1 = "y" | "r" | "g" | "b";
export const GRADE_WHEEL_BOUNDS_V1: Record<GradeWheelKindV1, readonly [number, number]> = { offset: [-.5, .5], lift: [-.5, .5], gamma: [-1, 1], gain: [-1, 2] };
const clamp = (v: number, low: number, high: number) => Math.max(low, Math.min(high, v));
export const gradePanelKeyV1 = (grade?: ColorGradeV2) => JSON.stringify(grade ?? null);
const baseGrade = (grade?: ColorGradeV2): ColorGradeV2 => grade ?? { schema: "editkin.color-grade/v2" };
export function addGradeNodeV1(grade?: ColorGradeV2): ColorGradeV2 {
  const old = baseGrade(grade), nodes = old.nodes ?? [];
  if (nodes.length >= COLOR_GRADE_V2_MAX_NODES) throw new Error("GRADE_PANEL_NODE_LIMIT");
  const id = ["grade1", "grade2", "grade3", "grade4"].find(value => !nodes.some(n => n.id === value))!;
  return assertColorGradeV2({ ...old, nodes: [...nodes, { id }] });
}
export function editGradeNodeV1(grade: ColorGradeV2 | undefined, id: string, edit: (node: ColorGradeNodeV2) => ColorGradeNodeV2): ColorGradeV2 {
  const old = baseGrade(grade), nodes = old.nodes ?? [];
  if (!nodes.some(node => node.id === id)) throw new Error("GRADE_PANEL_NODE_MISSING");
  return assertColorGradeV2({ ...old, nodes: nodes.map(node => node.id === id ? edit(structuredClone(node)) : node) });
}
export function removeGradeNodeV1(grade: ColorGradeV2 | undefined, id: string): ColorGradeV2 {
  const old = baseGrade(grade); if (!old.nodes?.some(node => node.id === id)) throw new Error("GRADE_PANEL_NODE_MISSING");
  return assertColorGradeV2({ ...old, nodes: old.nodes.filter(node => node.id !== id) });
}
export function moveGradeNodeV1(grade: ColorGradeV2 | undefined, id: string, direction: -1 | 1): ColorGradeV2 {
  const old = baseGrade(grade), nodes = [...(old.nodes ?? [])], index = nodes.findIndex(node => node.id === id), next = index + direction;
  if (index < 0 || next < 0 || next >= nodes.length) throw new Error("GRADE_PANEL_NODE_ORDER");
  [nodes[index], nodes[next]] = [nodes[next], nodes[index]];
  return assertColorGradeV2({ ...old, nodes });
}
/** Circular RGB opponent control, bounded chroma. Retains master and existing common RGB bias. */
export function wheelFromPointV1(wheel: ColorWheelV2 | undefined, kind: GradeWheelKindV1, x: number, y: number): ColorWheelV2 {
  if (![x, y].every(Number.isFinite)) throw new Error("GRADE_PANEL_WHEEL_POINT");
  const radius = Math.max(1, Math.hypot(x, y)); x /= radius; y /= radius;
  const scale = .25, bias = ((wheel?.r ?? 0) + (wheel?.g ?? 0) + (wheel?.b ?? 0)) / 3, [low, high] = GRADE_WHEEL_BOUNDS_V1[kind];
  return { ...wheel, r: clamp(bias + scale * x, low, high), g: clamp(bias + scale * (-.5 * x - Math.sqrt(3) / 2 * y), low, high), b: clamp(bias + scale * (-.5 * x + Math.sqrt(3) / 2 * y), low, high) };
}
export function wheelPointV1(wheel?: ColorWheelV2) {
  const r = wheel?.r ?? 0, g = wheel?.g ?? 0, b = wheel?.b ?? 0;
  const x = (2 * r - g - b) / .75, y = (b - g) / (Math.sqrt(3) * .25), radius = Math.max(1, Math.hypot(x, y));
  return { x: x / radius, y: y / radius };
}
export const identityCurveV1 = (): ColorCurvePointV2[] => [{ x: 0, y: 0 }, { x: 1, y: 1 }];
export function moveCurvePointV1(points: readonly ColorCurvePointV2[], index: number, x: number, y: number): ColorCurvePointV2[] {
  if (!points[index] || ![x, y].every(Number.isFinite)) throw new Error("GRADE_PANEL_CURVE_POINT");
  const current = points[index], low = points[index - 1]?.x, high = points[index + 1]?.x;
  const boundedX = low === undefined || high === undefined || high - low <= 2e-6 ? current.x : clamp(x, low + 1e-6, high - 1e-6);
  return points.map((point, i) => i === index ? { x: boundedX, y: clamp(y, 0, 1) } : { ...point });
}
export function addCurvePointV1(points: readonly ColorCurvePointV2[]): ColorCurvePointV2[] {
  if (points.length >= COLOR_GRADE_V2_MAX_CURVE_POINTS || points.length < 2) throw new Error("GRADE_PANEL_CURVE_LIMIT");
  let index = 0;
  for (let i = 1; i < points.length - 1; i++) if (points[i + 1].x - points[i].x > points[index + 1].x - points[index].x) index = i;
  const x = (points[index].x + points[index + 1].x) / 2;
  const curve = buildMonotoneCurve(points.map(p => p.x), points.map(p => p.y));
  return [...points.slice(0, index + 1), { x, y: clamp(evaluateMonotoneCurve(curve, x), 0, 1) }, ...points.slice(index + 1)].map(p => ({ ...p }));
}
export interface GradePanelEditScopeV1 { owner: object; sessionId: number }
export const sameGradePanelScopeV1 = (a?: GradePanelEditScopeV1, b?: GradePanelEditScopeV1) => a?.owner === b?.owner && a?.sessionId === b?.sessionId;
export interface GradePanelGestureV1 { clipId: string; baseKey: string; draft: ColorGradeV2; scope?: GradePanelEditScopeV1 }
export function beginGradePanelGestureV1(clipId: string, grade?: ColorGradeV2, scope?: GradePanelEditScopeV1): GradePanelGestureV1 {
  return { clipId, baseKey: gradePanelKeyV1(grade), draft: structuredClone(baseGrade(grade)), scope };
}
/** Synchronous owner/grade check at release: a late drag cannot replace a newer selection or Undo. */
export function settleGradePanelGestureV1(gesture: GradePanelGestureV1, clipId: string, current: ColorGradeV2 | undefined, editable: boolean, scope?: GradePanelEditScopeV1): ColorGradeV2 | undefined {
  if (!editable || gesture.clipId !== clipId || gesture.baseKey !== gradePanelKeyV1(current) || !sameGradePanelScopeV1(gesture.scope, scope)) return;
  const grade = assertColorGradeV2(gesture.draft);
  return gradePanelKeyV1(grade) === gesture.baseKey ? undefined : grade;
}
