import { acescctToLinear, displayToLinear, linearToAcescct, linearToDisplay } from "../color/gradeV2Color";
import type { TimelineTransitionHandlePlanV1 } from "../domain/timelineTransitionHandlesV1";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type MediaAsset, type TimelineClip } from "../domain/types";
import { compositeFrameClock } from "./compositeFrameClock";
import { timelineTransitionLinearShaderV1, type TransitionRgbaV1, type TransitionWorkingEncodingV1 } from "./timelineTransitionMixV1";

/**
 * Matte transition kernel (Motion Library Phase 3, kernel code 2):  out = mix(A, B, m) ⊕ overlay.
 *
 * - m is the per-pixel matte, read from the alpha of the rendered matte clip (renderItem.ts stores the matte in alpha).
 * - mix is the dissolve kernel with the progress replaced by m: scene-linear, premultiplied coverage,
 *   exact A where m = 0 and exact B where m = 1 (timelineTransitionMixV1's endpoint rule, per pixel).
 * - ⊕ is a straight-alpha "over" of the overlay clip, also in scene-linear light; exact passthrough where the overlay
 *   is transparent, and the overlay itself where it is opaque.
 *
 * Three implementations share this definition and are compared by test: the CPU reference below, the native-filter
 * FFmpeg graph timelineTransitionMatteMixGraphV1 (timelineTransitionMatteNativeV1.ts, software render path) and
 * timelineTransitionMatteShaderV1 (a separate canonical WGSL source; the shipped timeline_transition_v1.wgsl is not
 * touched, and the native host declines matte segments).
 */
export const TIMELINE_TRANSITION_MATTE_KERNEL_CODE_V1 = 2 as const;

function transfer(space: TransitionWorkingEncodingV1) {
  if (space === "linear") return { decode: (v: number) => v, encode: (v: number) => v };
  if (space === "acescct") return { decode: acescctToLinear, encode: linearToAcescct };
  if (space === "rec709_display") return { decode: displayToLinear, encode: linearToDisplay };
  throw Error("TIMELINE_TRANSITION_WORKING_ENCODING_INVALID");
}
const valid = (pixel: TransitionRgbaV1) => pixel.length === 4 && pixel.every(Number.isFinite) && pixel[3] >= 0 && pixel[3] <= 1;

/** CPU reference. Inputs are straight RGBA in one working encoding; the matte is a coverage value in 0..1. */
export function timelineTransitionMatteMixV1(from: TransitionRgbaV1, to: TransitionRgbaV1, matte: number, overlay: TransitionRgbaV1 | undefined,
  space: TransitionWorkingEncodingV1 = "linear"): TransitionRgbaV1 {
  const { decode, encode } = transfer(space);
  if (!valid(from) || !valid(to) || (overlay && !valid(overlay)) || !Number.isFinite(matte)) throw Error("TIMELINE_TRANSITION_PIXEL_INVALID");
  const m = Math.max(0, Math.min(1, matte)), oa = overlay ? overlay[3] : 0;
  const wa = (1 - m) * from[3], wb = m * to[3], mixAlpha = wa + wb;
  if (oa === 0) {
    if (m === 0) return from[3] === 0 ? [0, 0, 0, 0] : [...from];
    if (m === 1) return to[3] === 0 ? [0, 0, 0, 0] : [...to];
    if (mixAlpha === 0) return [0, 0, 0, 0];
    const rgb = [0, 1, 2].map(c => encode((wa * decode(from[c]) + wb * decode(to[c])) / mixAlpha));
    if (rgb.some(value => !Number.isFinite(value))) throw Error("TIMELINE_TRANSITION_NONFINITE_RESULT");
    return [rgb[0], rgb[1], rgb[2], mixAlpha];
  }
  if (oa === 1) return [...overlay!];
  const alpha = oa + mixAlpha * (1 - oa);
  const mixed = (c: number) => mixAlpha === 0 ? 0 : m === 0 ? decode(from[c]) : m === 1 ? decode(to[c]) : (wa * decode(from[c]) + wb * decode(to[c])) / mixAlpha;
  const rgb = [0, 1, 2].map(c => encode((oa * decode(overlay![c]) + mixAlpha * (1 - oa) * mixed(c)) / alpha));
  if (rgb.some(value => !Number.isFinite(value))) throw Error("TIMELINE_TRANSITION_NONFINITE_RESULT");
  return [rgb[0], rgb[1], rgb[2], alpha];
}

/** The 16-bit quantization of a normalized channel: floor(clip(v · 65535) + 0.5). */
export function timelineTransitionQuantize16V1(value: number): number {
  return Math.floor(Math.max(0, Math.min(65535, value * 65535)) + 0.5);
}

function label(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(value)) throw Error("TIMELINE_TRANSITION_GRAPH_LABEL_INVALID");
  return value;
}

// ---------------------------------------------------------------------------
// Software composite sources (ffmpegComposite wires the inputs; timelineTransitionCompositeGraphV1 consumes them)
// ---------------------------------------------------------------------------

/** One matte transition's inputs: the matte file as a raw FFmpeg input, and the overlay as an ordinary styled clip. */
export interface TimelineTransitionMatteSourceV1 {
  transitionId: string;
  matteAsset: MediaAsset;
  overlayAsset?: MediaAsset;
  /** A synthetic, unsaved clip that places the overlay on the transition window; it goes through the normal clip styling. */
  overlayClip?: TimelineClip;
}

/** The matte sources of a render plan, in plan order. Assets are looked up by the ids the validated field names. */
export function timelineTransitionMatteSourcesV1(project: Pick<EditProject, "assets" | "fps">, plans: readonly TimelineTransitionHandlePlanV1[]): TimelineTransitionMatteSourceV1[] {
  return plans.filter(plan => plan.transition.kernel === "matte").map(plan => {
    const field = plan.transition.motionLibrary;
    const matteAsset = project.assets.find(asset => asset.id === field?.matteAssetId);
    if (!field || !matteAsset) throw Error("TIMELINE_TRANSITION_MATTE_SOURCE_MISSING");
    const overlayAsset = field.overlayAssetId === undefined ? undefined : project.assets.find(asset => asset.id === field.overlayAssetId);
    if (field.overlayAssetId !== undefined && !overlayAsset) throw Error("TIMELINE_TRANSITION_MATTE_SOURCE_MISSING");
    const overlayClip: TimelineClip | undefined = overlayAsset && { id: `${plan.transition.id}::motionlib-overlay`, assetId: overlayAsset.id, trackId: plan.transition.trackId,
      timelineStart: plan.startFrame / project.fps, sourceStart: 0, duration: plan.durationFrames / project.fps, volume: 0,
      transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] };
    return { transitionId: plan.transition.id, matteAsset, ...(overlayAsset ? { overlayAsset, overlayClip } : {}) };
  });
}

/**
 * The matte clip on the composite clock, transition window only: frame k of the matte file at project frame
 * startFrame + k, its alpha (the matte) at full 16-bit scale. Same clock filters as aces16PositionedLayerGraphV1.
 * The ProRes 4444 matte decodes as 12-bit alpha shifted to 16 bits (4095 → 65520); a 16-bit lookup table bit-replicates
 * it (a + floor(a / 4096)), so full coverage is exactly 65535 (m = 1, pure B) and zero stays zero. The table works on
 * packed RGBA64 (FFmpeg's lut filters negotiate 8-bit for planar 16-bit RGB); both conversions only move samples.
 */
export function timelineTransitionMatteStreamV1(inputIndex: number, output: string, window: { startFrame: number; durationFrames: number },
  plan: { fps: number; duration: number }): string {
  label(output);
  if (!Number.isSafeInteger(inputIndex) || inputIndex < 0 || !Number.isSafeInteger(window.startFrame) || window.startFrame < 0
    || !Number.isSafeInteger(window.durationFrames) || window.durationFrames < 1) throw Error("TIMELINE_TRANSITION_FRAME_WINDOW_INVALID");
  const frames = Math.ceil(plan.duration * plan.fps), clock = compositeFrameClock(plan.fps, window.startFrame / plan.fps);
  if (!Number.isSafeInteger(frames) || frames < 1 || clock.startFrame !== window.startFrame || window.startFrame + window.durationFrames > frames) {
    throw Error("TIMELINE_TRANSITION_FRAME_WINDOW_INVALID");
  }
  return `[${inputIndex}:v]fps=${clock.rate},trim=end_frame=${window.durationFrames},format=rgba64le,lutrgb=a='val+floor(val/4096)',format=gbrap16le,`
    + `${clock.timestampFilters}[${output}]`;
}

/** A named function of the shipped linear shader, sliced verbatim (so kernels 0 and 1 stay byte-for-byte the same code). */
function linearShaderFunction(name: string): string {
  const source = timelineTransitionLinearShaderV1();
  const start = source.indexOf(`fn ${name}(`);
  const end = source.indexOf("\n}\n", start);
  if (start < 0 || end < 0) throw Error(`TIMELINE_TRANSITION_SHADER_FUNCTION_MISSING:${name}`);
  return source.slice(start, end + 3);
}

/**
 * Canonical matte-capable WGSL (frontend module only; not a native host input). Bindings 0–2 and the vertex stage are
 * those of timeline_transition_v1.wgsl; bindings 3 and 4 add the matte and overlay textures. kernel 0 and 1 run the
 * shipped transition_pixel_v1 verbatim, kernel 2 runs the matte kernel. Params keep the 16-byte layout: the old pad0 is
 * has_overlay (0 or 1).
 */
export function timelineTransitionMatteShaderV1(): string {
  return `struct TransitionParams { progress: f32, kernel: u32, has_overlay: u32, pad1: u32 };
@group(0) @binding(0) var from_texture: texture_2d<f32>;
@group(0) @binding(1) var to_texture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: TransitionParams;
@group(0) @binding(3) var matte_texture: texture_2d<f32>;
@group(0) @binding(4) var overlay_texture: texture_2d<f32>;
@vertex fn vertex_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
 let positions = array<vec2<f32>,3>(vec2<f32>(-1.0,-1.0),vec2<f32>(3.0,-1.0),vec2<f32>(-1.0,3.0));
 return vec4<f32>(positions[index],0.0,1.0);
}
${linearShaderFunction("transition_pixel_v1")}fn transition_matte_pixel_v1(position: vec4<f32>) -> vec4<f32> {
 let coordinate=vec2<i32>(position.xy);
 let a=textureLoad(from_texture,coordinate,0); let b=textureLoad(to_texture,coordinate,0);
 let m=clamp(textureLoad(matte_texture,coordinate,0).a,0.0,1.0);
 let wa=(1.0-m)*a.a; let wb=m*b.a; let mix_alpha=wa+wb;
 var mixed=vec4<f32>(0.0);
 if(m==0.0){if(a.a!=0.0){mixed=a;}}
 else if(m==1.0){if(b.a!=0.0){mixed=b;}}
 else if(mix_alpha!=0.0){mixed=vec4<f32>((wa*a.rgb+wb*b.rgb)/mix_alpha,mix_alpha);}
 if(params.has_overlay==0u){return mixed;}
 let o=textureLoad(overlay_texture,coordinate,0);
 if(o.a==0.0){return mixed;}
 if(o.a==1.0){return o;}
 let alpha=o.a+mixed.a*(1.0-o.a);
 return vec4<f32>((o.a*o.rgb+mixed.a*(1.0-o.a)*mixed.rgb)/alpha,alpha);
}
fn transition_dispatch_v1(position: vec4<f32>) -> vec4<f32> {
 if(params.kernel==2u){return transition_matte_pixel_v1(position);}
 return transition_pixel_v1(position);
}
${linearShaderFunction("transition_half_nearest_even_v1")}@fragment fn fragment_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
 return transition_dispatch_v1(position);
}
@fragment fn fragment_main_f16(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
 let value=transition_dispatch_v1(position);
 return vec4<f32>(transition_half_nearest_even_v1(value.r),transition_half_nearest_even_v1(value.g),transition_half_nearest_even_v1(value.b),transition_half_nearest_even_v1(value.a));
}
`;
}
