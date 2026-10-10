/** Saved, original Editkin geometry data. No renderer or component payload. */
export interface SpringDynamics { stiffness: number; damping: number; mass: number }
export interface SpringTargetEvent { frame: number; target: number }
export interface SpringTargetTrack {
  fps: number;
  initialPosition: number;
  /** Position units per second, independent of project frame rate. */
  initialVelocity: number;
  initialTarget: number;
  spring: SpringDynamics;
  events: readonly SpringTargetEvent[];
}
export interface SpringTargetSample { position: number; velocity: number }
export interface SpringGeometryTrack {
  localId: string;
  envelope: { x: number; y: number; width: number; height: number };
  left: SpringTargetTrack;
  top: SpringTargetTrack;
  right: SpringTargetTrack;
  bottom: SpringTargetTrack;
  cornerRadius: SpringTargetTrack;
}
export interface SpringRoundedRect { x: number; y: number; width: number; height: number; cornerRadius: number }
export interface SpringGeometrySample {
  localId: string;
  envelope: SpringGeometryTrack["envelope"];
  geometry: SpringRoundedRect;
  velocity: SpringRoundedRect;
}
