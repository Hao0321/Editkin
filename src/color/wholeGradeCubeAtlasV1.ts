import { sampleCubeLut, type CubeLut } from './cubeLut';
export const WHOLE_GRADE_CUBE_SIZE_V1=65;
export const WHOLE_GRADE_HOLDOUTS_V1=512;
/** One FLOAT colour atlas, red fastest. The last row contains independent off-grid controls. */
export function wholeGradeAtlasV1(size=WHOLE_GRADE_CUBE_SIZE_V1){
  if(!Number.isInteger(size)||size<2||size>129)throw Error('整套調色 LUT 尺寸必須介於 2–129。');
  const width=Math.max(512,size*13),gridCount=size**3,height=Math.ceil((gridCount+WHOLE_GRADE_HOLDOUTS_V1)/width),pixels=width*height;
  const rgb=new Float32Array(pixels*3);let state=0x4d595df4;
  const random=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return(state>>>0)/4294967295;};
  for(let i=0;i<pixels;i++)for(let c=0;c<3;c++)rgb[i*3+c]=i<gridCount?Math.floor(i/size**c)%size/(size-1):i<gridCount+512?random():0;
  const bytes=new Uint8Array(pixels*12),view=new DataView(bytes.buffer);
  // FFmpeg gbrpf32le is planar G,B,R, not packed RGB; no 8-bit source quantization.
  for(let i=0;i<pixels;i++)for(let p=0;p<3;p++)view.setFloat32((p*pixels+i)*4,rgb[i*3+([1,2,0][p])],true);
  return{size,width,height,pixels,gridCount,rgb,bytes};
}
export function unpackWholeGradeAtlasV1(bytes:Uint8Array,atlas:ReturnType<typeof wholeGradeAtlasV1>){
  if(bytes.byteLength!==atlas.pixels*6)throw Error('整套調色 LUT 回讀長度不符。');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),rgb=new Float32Array(atlas.pixels*3);
  for(let i=0;i<atlas.pixels;i++)for(let p=0;p<3;p++)rgb[i*3+([1,2,0][p])]=view.getUint16((p*atlas.pixels+i)*2,true)/65535;
  return rgb;
}
export function wholeGradeAtlasCubeV1(atlas:ReturnType<typeof wholeGradeAtlasV1>,output:Float32Array,title:string){
  if(output.length!==atlas.pixels*3||!output.every(v=>Number.isFinite(v)&&v>=0&&v<=1))throw Error('整套調色 LUT 回讀內容不合法。');
  const values=output.slice(0,atlas.gridCount*3);for(let i=0;i<values.length;i++)values[i]=Math.round(values[i]*1e6)/1e6;
  const cube:CubeLut={size:atlas.size,domainMin:[0,0,0],domainMax:[1,1,1],values};
  let maximumCodeError=0,totalCodeError=0,worst:{sample:number;channel:number;input:number[];predicted:number;actual:number}|undefined;
  for(let i=atlas.gridCount;i<atlas.gridCount+512;i++){
    const sampled=sampleCubeLut(cube,[atlas.rgb[i*3],atlas.rgb[i*3+1],atlas.rgb[i*3+2]]);
    for(let c=0;c<3;c++){const error=Math.abs(sampled[c]-output[i*3+c])*255;if(error>maximumCodeError){maximumCodeError=error;worst={sample:i-atlas.gridCount,channel:c,input:Array.from(atlas.rgb.slice(i*3,i*3+3)),predicted:sampled[c],actual:output[i*3+c]};}totalCodeError+=error;}
  }
  const quality={size:atlas.size,holdouts:512,channels:1536,maximumCodeError,meanCodeError:totalCodeError/1536,limitCodeError:2,worst,scope:'fixed512off-grid-atlas-controls-only' as const};
  if(maximumCodeError>2)throw Object.assign(Error('整套調色 LUT 的近似誤差超過上限；這次未匯出。'),{quality});
  // Bounded string blocks avoid retaining millions of individual row strings for a129cube.
  const titleText=title.replace(/["\r\n]/g,'').slice(0,120),blocks=[`TITLE "${titleText}"\nLUT_3D_SIZE ${atlas.size}\n`];
  for(let start=0;start<values.length;start+=4096*3){const rows:string[]=[];for(let i=start;i<Math.min(values.length,start+4096*3);i+=3)rows.push(`${values[i].toFixed(6)} ${values[i+1].toFixed(6)} ${values[i+2].toFixed(6)}`);blocks.push(rows.join('\n')+'\n');}
  const text=blocks.join('');if(new TextEncoder().encode(text).byteLength>64*1024*1024)throw Error('整套調色 LUT 超過輸出大小上限。');
  return{cube,text,quality};
}
