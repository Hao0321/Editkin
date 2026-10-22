import {hologramSeedHashV2,hologramTemporalV2,validateHologramFrameV2,type HologramFrameInputV2} from "../domain/hologramMaterialV2";

/** Independent CPU reference. Box kernels use zero padding, including the full denominator at an edge. */
export function hologramBoxBlurV2(source:Float32Array,width:number,height:number,radius:number):Float32Array {
  const horizontal=new Float32Array(source.length),output=new Float32Array(source.length),denominator=radius*2+1;
  for(let y=0;y<height;y++){
    let sum=0;for(let k=0;k<=Math.min(radius,width-1);k++)sum+=source[y*width+k];
    for(let x=0;x<width;x++){
      horizontal[y*width+x]=sum/denominator;
      if(x-radius>=0)sum-=source[y*width+x-radius];if(x+radius+1<width)sum+=source[y*width+x+radius+1];
    }
  }
  for(let x=0;x<width;x++){
    let sum=0;for(let k=0;k<=Math.min(radius,height-1);k++)sum+=horizontal[k*width+x];
    for(let y=0;y<height;y++){
      output[y*width+x]=sum/denominator;
      if(y-radius>=0)sum-=horizontal[(y-radius)*width+x];if(y+radius+1<height)sum+=horizontal[(y+radius+1)*width+x];
    }
  }
  return output;
}
export function renderHologramReferenceV2(input:HologramFrameInputV2):Float32Array {
  const m=validateHologramFrameV2(input),{width,height,coverage,baseLinearRgba}=input,t=hologramTemporalV2(m,input.frame,input.fps);
  const glow=hologramBoxBlurV2(coverage,width,height,m.glowRadius),bloom=hologramBoxBlurV2(coverage,width,height,m.bloomRadius),output=new Float32Array(baseLinearRgba.length);
  const at=(x:number,y:number)=>x<0||x>=width?0:coverage[y*width+x];
  for(let y=0;y<height;y++){
    const shift=hologramSeedHashV2(t.slotSeed^Math.floor(y/m.glitchBandHeight))%(2*t.shiftLimit+1)-t.shiftLimit;
    const scan=1-m.scanlineAmount*.5*(1+Math.sin(y*2*Math.PI/m.scanlinePeriod));
    for(let x=0;x<width;x++){
      const i=y*width+x,halo=m.glowAmount*glow[i]+m.bloomAmount*bloom[i];
      for(let c=0;c<3;c++){
        const offset=c===0?-m.dispersionPixels:c===2?m.dispersionPixels:0;
        output[4*i+c]=baseLinearRgba[4*i+c]+m.colorLinear[c]*m.strength*t.gain*(at(x+shift+offset,y)*scan+halo);
      }
      output[4*i+3]=1;
    }
  }
  return output;
}

/** Binary ABI for the independent WGSL kernel; integer seed bits are never converted to float. */
export function hologramParametersV2(input:HologramFrameInputV2):Uint32Array {
  const m=validateHologramFrameV2(input),t=hologramTemporalV2(m,input.frame,input.fps),buffer=new ArrayBuffer(80),u=new Uint32Array(buffer),f=new Float32Array(buffer);
  u[0]=input.width;u[1]=input.height;u[2]=m.glowRadius;u[3]=m.bloomRadius;
  f.set(m.colorLinear,4);f[7]=m.strength;f[8]=m.glowAmount;f[9]=m.bloomAmount;
  u[10]=m.dispersionPixels;u[11]=m.scanlinePeriod;f[12]=m.scanlineAmount;f[13]=t.gain;u[14]=t.shiftLimit;u[15]=m.glitchBandHeight;u[16]=t.slotSeed;
  return u;
}
