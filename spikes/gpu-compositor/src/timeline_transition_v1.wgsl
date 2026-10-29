struct TransitionParams { progress: f32, kernel: u32, pad0: u32, pad1: u32 };
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
