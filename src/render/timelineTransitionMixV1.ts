import { acescctToLinear, displayToLinear, linearToAcescct, linearToDisplay } from "../color/gradeV2Color";
import { escapeExpression } from "./ffmpegExpressions";
import type { TimelineTransition } from "../domain/timelineTransitionV1";

export type TransitionWorkingEncodingV1 = "linear" | "acescct" | "rec709_display";
export type TransitionRgbaV1 = readonly [number, number, number, number];
export function timelineTransitionKernelCodeV1(kernel: TimelineTransition["kernel"]): 0 | 1 {
  if (kernel === "dissolve") return 0;
  if (kernel === "dip") return 1;
  throw Error("TIMELINE_TRANSITION_KERNEL_INVALID");
}
function encoding(space: TransitionWorkingEncodingV1) {
  if (space === "linear") return { decode: (v: number) => v, encode: (v: number) => v };
  if (space === "acescct") return { decode: acescctToLinear, encode: linearToAcescct };
  if (space === "rec709_display") return { decode: displayToLinear, encode: linearToDisplay };
  throw Error("TIMELINE_TRANSITION_WORKING_ENCODING_INVALID");
}

/** Both inputs are straight RGBA in one declared working encoding. Mix in
 * scene-linear, premultiplied coverage and return straight RGBA. */
export function timelineTransitionMixV1(from: TransitionRgbaV1, to: TransitionRgbaV1, progress: number,
  kernel: TimelineTransition["kernel"], space: TransitionWorkingEncodingV1 = "linear"): TransitionRgbaV1 {
  const mode = timelineTransitionKernelCodeV1(kernel), transfer = encoding(space);
  if (!Number.isFinite(progress) || [...from, ...to].some(v => !Number.isFinite(v)) || from[3] < 0 || from[3] > 1 || to[3] < 0 || to[3] > 1) throw Error("TIMELINE_TRANSITION_PIXEL_INVALID");
  const u = Math.max(0, Math.min(1, progress));
  if (u === 0) return from[3] === 0 ? [0, 0, 0, 0] : [...from];
  if (u === 1) return to[3] === 0 ? [0, 0, 0, 0] : [...to];
  const fromWeight = mode === 0 ? 1 - u : Math.max(0, 1 - 2 * u);
  const toWeight = mode === 0 ? u : Math.max(0, 2 * u - 1);
  const blackWeight = mode === 0 ? 0 : 2 * Math.min(u, 1 - u);
  const a = fromWeight * from[3], b = toWeight * to[3], alpha = a + b + blackWeight;
  if (alpha === 0) return [0, 0, 0, 0];
  const rgb = [0, 1, 2].map(c => transfer.encode((a * transfer.decode(from[c]) + b * transfer.decode(to[c])) / alpha));
  if (rgb.some(v => !Number.isFinite(v))) throw Error("TIMELINE_TRANSITION_NONFINITE_RESULT");
  return [rgb[0], rgb[1], rgb[2], alpha];
}

function label(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(value)) throw Error("TIMELINE_TRANSITION_GRAPH_LABEL_INVALID");
  return value;
}
/** Explicit GBRAP16 inputs/output; the host binds this same progress clock to
 * the native linear shader. No8/10-bit overlay or alpha merge is admitted. */
export function timelineTransitionMixGraphV1(from: string, to: string, output: string,
  window: { startFrame: number; durationFrames: number }, kernel: TimelineTransition["kernel"], space: TransitionWorkingEncodingV1): string[] {
  const mode = timelineTransitionKernelCodeV1(kernel); encoding(space);
  [from, to, output].forEach(label);
  if (!Number.isSafeInteger(window.startFrame) || window.startFrame < 0 || !Number.isSafeInteger(window.durationFrames) || window.durationFrames < 1) throw Error("TIMELINE_TRANSITION_FRAME_WINDOW_INVALID");
  const u = `clip((N-${window.startFrame})/${window.durationFrames},0,1)`;
  const aWeight = mode === 0 ? "1-ld(0)" : "max(0,1-2*ld(0))", bWeight = mode === 0 ? "ld(0)" : "max(0,2*ld(0)-1)";
  const black = mode === 0 ? "0" : "2*min(ld(0),1-ld(0))";
  const prefix = `st(0,${u});st(1,(${aWeight})*alpha(X,Y)/65535);st(2,(${bWeight})*alpha(X+W/2,Y)/65535);st(3,ld(1)+ld(2)+(${black}));`;
  const decode = (v: string) => space === "linear" ? v : space === "rec709_display" ? `pow(${v},2.4)`
    : `if(lte(${v},0.155251141552511),(${v}-0.0729055341958355)/10.5402377416545,pow(2,${v}*17.52-9.72))`;
  const encode = (v: string) => space === "linear" ? v : space === "rec709_display" ? `pow(max(0,${v}),1/2.4)`
    : `if(lte(${v},0.0078125),10.5402377416545*(${v})+0.0729055341958355,(log(${v})/log(2)+9.72)/17.52)`;
  const colour = (plane: string) => {
    const a = `${plane}(X,Y)/65535`, b = `${plane}(X+W/2,Y)/65535`;
    const mixed = `(ld(1)*(${decode(a)})+ld(2)*(${decode(b)}))/ld(3)`;
    return prefix + `if(eq(ld(3),0),0,if(eq(ld(0),0),${plane}(X,Y),if(eq(ld(0),1),${plane}(X+W/2,Y),floor(clip((${encode(mixed)})*65535,0,65535)+0.5))))`;
  };
  const q = (value: string) => `'${escapeExpression(value)}'`, planes = `${output}pairplanes`;
  return [`[${label(from)}][${label(to)}]hstack=inputs=2[${planes}]`,
    `[${planes}]geq=r=${q(colour("r"))}:g=${q(colour("g"))}:b=${q(colour("b"))}:a=${q(prefix + "floor(clip(ld(3)*65535,0,65535)+0.5)")}:interpolation=nearest,crop=w=iw/2:h=ih:x=0:y=0,format=gbrap16le[${label(output)}]`];
}

/** Scene-linear shader source shared by actual preview, render and thumbnails.
 * Input colour decoding and final output encoding belong to their colour passes. */
export function timelineTransitionLinearShaderV1(): string {
  return `struct TransitionParams { progress: f32, kernel: u32, pad0: u32, pad1: u32 };
@group(0) @binding(0) var from_texture: texture_2d<f32>;
@group(0) @binding(1) var to_texture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: TransitionParams;
@vertex fn vertex_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
 let positions = array<vec2<f32>,3>(vec2<f32>(-1.0,-1.0),vec2<f32>(3.0,-1.0),vec2<f32>(-1.0,3.0));
 return vec4<f32>(positions[index],0.0,1.0);
}
fn transition_pixel_v1(position: vec4<f32>) -> vec4<f32> {
 let coordinate=vec2<i32>(position.xy);
 let a=textureLoad(from_texture,coordinate,0); let b=textureLoad(to_texture,coordinate,0);
 let u=clamp(params.progress,0.0,1.0);
 if(u==0.0){if(a.a==0.0){return vec4<f32>(0.0);}return a;}
 if(u==1.0){if(b.a==0.0){return vec4<f32>(0.0);}return b;}
 var from_weight=1.0-u; var to_weight=u; var black_weight=0.0;
 if(params.kernel==1u){from_weight=max(0.0,1.0-2.0*u);to_weight=max(0.0,2.0*u-1.0);black_weight=2.0*min(u,1.0-u);}
 let wa=from_weight*a.a;let wb=to_weight*b.a;let alpha=wa+wb+black_weight;
 if(alpha==0.0){return vec4<f32>(0.0);}
 return vec4<f32>((wa*a.rgb+wb*b.rgb)/alpha,alpha);
}
fn transition_half_nearest_even_v1(value: f32) -> f32 {
 let bits=bitcast<u32>(value); let sign=bits&0x80000000u; let magnitude=bits&0x7fffffffu;
 // Leave nonfinite inputs to the upstream linear surface contract.
 if(magnitude>=0x7f800000u){return value;}
 if(magnitude>=0x38800000u){
  // Discard13 F32 fraction bits, with ties to even. The result itself is
  // exactly representable in F16, so the attachment cannot round it away.
  let rounded=(magnitude+0xfffu+((magnitude>>13u)&1u))&0xffffe000u;
  return bitcast<f32>(sign|rounded);
 }
 let nearest=round(abs(value)*16777216.0)*0.000000059604644775390625;
 if(sign!=0u){return -nearest;}return nearest;
}
@fragment fn fragment_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
 return transition_pixel_v1(position);
}
@fragment fn fragment_main_f16(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
 let value=transition_pixel_v1(position);
 return vec4<f32>(transition_half_nearest_even_v1(value.r),transition_half_nearest_even_v1(value.g),transition_half_nearest_even_v1(value.b),transition_half_nearest_even_v1(value.a));
}
`;
}
