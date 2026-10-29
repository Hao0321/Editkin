/** Separate original material. Frozen hologram v1 presets and their native renderer remain unchanged. */
export const HOLOGRAM_SHADER_V2 = /* wgsl */`
@group(0) @binding(0) var<storage,read> coverage:array<f32>;
@group(0) @binding(1) var<storage,read> base:array<f32>;
@group(0) @binding(2) var<storage,read_write> horizontalGlow:array<f32>;
@group(0) @binding(3) var<storage,read_write> horizontalBloom:array<f32>;
@group(0) @binding(4) var<storage,read_write> glow:array<f32>;
@group(0) @binding(5) var<storage,read_write> bloom:array<f32>;
@group(0) @binding(6) var<storage,read_write> output:array<f32>;
@group(0) @binding(7) var<storage,read> params:array<u32>;
fn p(i:u32)->f32{return bitcast<f32>(params[i]);}
fn hash(v0:u32)->u32{var v=v0;v=v^(v>>16u);v=v*0x7feb352du;v=v^(v>>15u);v=v*0x846ca68bu;return v^(v>>16u);}
fn maskAt(x:i32,y:u32)->f32{if(x<0||x>=i32(params[0])){return 0.;}return coverage[y*params[0]+u32(x)];}
@compute @workgroup_size(64) fn horizontal(@builtin(global_invocation_id) id:vec3<u32>){
  let i=id.x;let w=params[0];if(i>=w*params[1]){return;}let x=i%w;let y=i/w;var a=0.;var b=0.;
  for(var k=-i32(params[2]);k<=i32(params[2]);k=k+1){a=a+maskAt(i32(x)+k,y);}
  for(var k=-i32(params[3]);k<=i32(params[3]);k=k+1){b=b+maskAt(i32(x)+k,y);}
  horizontalGlow[i]=a/f32(params[2]*2u+1u);horizontalBloom[i]=b/f32(params[3]*2u+1u);
}
@compute @workgroup_size(64) fn vertical(@builtin(global_invocation_id) id:vec3<u32>){
  let i=id.x;let w=params[0];let h=params[1];if(i>=w*h){return;}let x=i%w;let y=i/w;var a=0.;var b=0.;
  for(var k=-i32(params[2]);k<=i32(params[2]);k=k+1){let q=i32(y)+k;if(q>=0&&q<i32(h)){a=a+horizontalGlow[u32(q)*w+x];}}
  for(var k=-i32(params[3]);k<=i32(params[3]);k=k+1){let q=i32(y)+k;if(q>=0&&q<i32(h)){b=b+horizontalBloom[u32(q)*w+x];}}
  glow[i]=a/f32(params[2]*2u+1u);bloom[i]=b/f32(params[3]*2u+1u);
}
@compute @workgroup_size(64) fn composite(@builtin(global_invocation_id) id:vec3<u32>){
  let i=id.x;let w=params[0];if(i>=w*params[1]){return;}let x=i%w;let y=i/w;
  let shift=i32(hash(params[16]^(y/params[15]))%(params[14]*2u+1u))-i32(params[14]);
  let scan=1.-p(12)*.5*(1.+sin(f32(y)*6.283185307179586/f32(params[11])));
  let halo=p(8)*glow[i]+p(9)*bloom[i];
  for(var c=0u;c<3u;c=c+1u){var offset=0;if(c==0u){offset=-i32(params[10]);}else if(c==2u){offset=i32(params[10]);}
    output[i*4u+c]=base[i*4u+c]+p(4u+c)*p(7)*p(13)*(maskAt(i32(x)+shift+offset,y)*scan+halo);
  }
  output[i*4u+3u]=1.;
}
`;
