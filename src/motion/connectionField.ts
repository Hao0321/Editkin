import type { MotionVectorV2 } from "../domain/types";

export type ConnectionField = Extract<MotionVectorV2, { kind: "connection_field" }>;
export interface ConnectionPoint { x: number; y: number; radius: number; group: number }
export const CONNECTION_FIELD_GROUP_CENTERS = [{ x: .25, y: .23 }, { x: .79, y: .4 }, { x: .34, y: .8 }] as const;

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const ease = (value: number) => { const t = clamp(value); return t * t * (3 - 2 * t); };

/** Three finite changes with exact stationary holds; no simulation state or sine sway. */
export function connectionFieldGeometry(value: ConnectionField, width: number, height: number, frame: number) {
  let seed = value.seed >>> 0;
  const random = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let n = Math.imul(seed ^ (seed >>> 15), seed | 1);
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
  const burst = ease(frame / value.burstFrames);
  const gather = ease((frame - value.gatherStartFrame) / value.gatherFrames);
  const connect = ease((frame - value.connectStartFrame) / value.connectFrames);
  const center = { x: width * .53, y: height * .55 };
  const points: ConnectionPoint[] = Array.from({ length: value.points }, (_, index) => {
    const scattered = { x: width * (.07 + random() * .86), y: height * (.1 + random() * .8) };
    const group = index % 3, rank = Math.floor(index / 3), count = Math.floor((value.points + 2 - group) / 3);
    const angle = rank * Math.PI * 2 / count + group * .43 - Math.PI / 2;
    const cluster = CONNECTION_FIELD_GROUP_CENTERS[group], radius = [.15, .14, .16][group];
    const target = { x: width * (cluster.x + Math.cos(angle) * radius), y: height * (cluster.y + Math.sin(angle) * radius) };
    const x = center.x + (scattered.x - center.x) * burst, y = center.y + (scattered.y - center.y) * burst;
    return { x: x + (target.x - x) * gather, y: y + (target.y - y) * gather,
      radius: value.dotRadiusPixels * (.75 + random() * .5), group };
  });
  const edges = points.flatMap((point, index) => {
    const next = index + 3 < points.length ? index + 3 : point.group;
    const targets = [points[next], ...(index % 4 === 0 ? [center] : [])];
    return targets.map(target => ({ from: point, to: { x: point.x + (target.x - point.x) * connect, y: point.y + (target.y - point.y) * connect } }));
  });
  return { points, edges: connect > 0 ? edges : [], center, connect };
}
