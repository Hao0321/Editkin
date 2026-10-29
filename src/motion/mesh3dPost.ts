import type { Mesh3dPost } from "./mesh3dScene";
import { mesh3dKernelFactoryV1, type Mesh3dKernelPostV1 } from "./mesh3dKernel";

/**
 * Scene post effects for the CPU mesh renderer (engine extension 2026-10-23). Order:
 * motion-blur gap fill → ambient occlusion → depth of field → bloom → fisheye →
 * vignette → 8-bit. All radii scale with the frame height, so preview and export sizes
 * look alike. The filters live in mesh3dKernel.ts (shared with worker threads); these
 * are the single-thread entry points.
 *
 * DOF is a weighted gather on a quarter-resolution pyramid: each pixel's circle of
 * confusion selects between the sharp frame and three blur levels; in-focus pixels
 * carry zero weight so they never smear into a blurred background, and the blurred
 * near-field coverage spills over sharp pixels behind it. Blurs average in
 * approximately linear light (squared values).
 */
export interface Mesh3dPostFrameV1 {
  width: number; height: number;
  /** Display-referred RGB, 0..1+ (unclamped where the scene was rendered with HDR). */
  color: Float32Array;
  /** The rasterizer's NDC depth (Infinity = background). */
  depth: Float32Array;
  near: number; far: number;
}
const kernel = mesh3dKernelFactoryV1();

/** Approximate Gaussian (three box passes per axis), in place. */
export function mesh3dGaussianBlurV1(buffer: Float32Array, w: number, h: number, channels: number, sigma: number): void {
  kernel.blur(kernel.serialCtx(), buffer, new Float32Array(buffer.length), w, h, channels, sigma);
}
/**
 * Motion-blur gap fill: a fast camera move turns N sub-frames into N visible copies.
 * Box-filtering the averaged frame along the per-sample camera shift (sx, sy pixels)
 * joins them into one streak. Static cameras (shift < 1 px) are left untouched.
 */
export function mesh3dMotionGapFillV1(color: Float32Array, w: number, h: number, sx: number, sy: number): void {
  kernel.gapFill(kernel.serialCtx(), color, new Float32Array(color.length), w, h, sx, sy);
}
/**
 * Apply a scene's post chain (DOF in place on `frame.color`) and return the delivered 8-bit RGBA.
 * Ambient occlusion needs the renderer's per-pixel material mask, so it only runs inside a frame render.
 */
export function mesh3dApplyPostV1(post: Mesh3dPost, frame: Mesh3dPostFrameV1): Uint8ClampedArray {
  if (frame.color.length !== frame.width * frame.height * 3 || frame.depth.length !== frame.width * frame.height) throw new Error("MESH_POST_FRAME_INVALID");
  const w = frame.width, h = frame.height, n = w * h, qw = Math.ceil(w / 4), qh = Math.ceil(h / 4), q = qw * qh;
  const record: Mesh3dKernelPostV1 = { near: frame.near, far: frame.far, color: frame.color, depth: frame.depth, out: new Uint8ClampedArray(n * 4),
    ...(post.dof ? { dof: post.dof, coc: new Float32Array(n), dofQuarter: new Float32Array(q * 7), dofCounts: new Float32Array(q), dofLevels: [0, 1, 2].map(() => new Float32Array(q * 7)), dofComposite: new Float32Array(q * 5), dofTemp: new Float32Array(q * 7) } : {}),
    ...(post.bloom ? { bloom: post.bloom, bloomData: new Float32Array(q * 3), bloomCounts: new Float32Array(q), bloomGlow: new Float32Array(q * 3), bloomLayer: new Float32Array(q * 3), bloomTemp: new Float32Array(q * 3) } : {}),
    ...(post.fisheye ? { fisheye: post.fisheye } : {}), ...(post.vignette ? { vignette: post.vignette } : {}) };
  kernel.postPhases(kernel.serialCtx(), record, w, h);
  return record.out;
}
