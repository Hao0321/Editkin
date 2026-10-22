export const RGB8_CUBE_TEXT_BLOCK_BYTES_V1=65536;
export const RGB8_CUBE_TEXT_MAX_BYTES_V1=512*1024*1024;
// Native readers truncate and also accumulate interpolation roundoff at nominal vertices.
// A quarter-code guard sits strictly inside both truncation's [n,n+1) and rounding's [n-.5,n+.5).
// This is a BYTE-output transport table, not a FLOAT/HDR grade; white may be slightly above1 before output clipping.
const RGB8_TEXT=Array.from({length:256},(_,code)=>((code+.25)/255).toFixed(6));
export interface Rgb8CubeTextOptionsV1 {maximumBytes:number;title?:string;signal?:AbortSignal}
/** Output-only building block for a dense RGB8 vertex map. Plane order is blue,
 * then green, with red fastest; each plane is packed RGB, never FFmpeg planar GBR.
 * The caller must keep output staged and publish only after complete iteration.
 * This does not bake a renderer, certify quality, or expand the129/64MiB importer. */
export async function* rgb8CubeTextBlocksV1(size:number,planes:Iterable<Uint8Array>|AsyncIterable<Uint8Array>,options:Rgb8CubeTextOptionsV1):AsyncGenerator<Uint8Array>{
  options.signal?.throwIfAborted();
  if(!Number.isInteger(size)||size<2||size>256)throw Error('RGB8 LUT 尺寸必須介於 2–256。');
  if(options.title!==undefined&&(typeof options.title!=='string'||options.title.length>120||!/^[\x20-\x21\x23-\x7e]*$/.test(options.title)))throw Error('RGB8 LUT 標題格式不合法。');
  const encoder=new TextEncoder(),header=encoder.encode(`${options.title===undefined?'':`TITLE "${options.title}"\n`}# RGB8 byte-output table with quarter-code guard; not FLOAT or HDR\nLUT_3D_SIZE ${size}\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n`);
  // Every byte value has exactly8characters at six decimal places; each RGB row is27bytes.
  const planned=header.byteLength+27*size**3;
  if(!Number.isSafeInteger(options.maximumBytes)||options.maximumBytes<=0||options.maximumBytes>RGB8_CUBE_TEXT_MAX_BYTES_V1||planned>options.maximumBytes)throw Error('RGB8 LUT 匯出超過指定容量；已停止。');
  yield header;let planeCount=0,emitted=header.byteLength;
  for await(const input of planes){
    options.signal?.throwIfAborted();
    if(++planeCount>size)throw Error('RGB8 LUT 分片數量不完整或過多。');
    if(!(input instanceof Uint8Array)||input.byteLength!==size*size*3||(typeof SharedArrayBuffer!=='undefined'&&input.buffer instanceof SharedArrayBuffer)||(input.buffer as ArrayBuffer&{resizable?:boolean}).resizable)throw Error('RGB8 LUT 分片長度或格式不合法。');
    // Buffer.slice aliases memory. Copy one plane so later producer changes cannot alter an in-progress plane.
    const plane=new Uint8Array(input);
    for(let start=0;start<plane.length;start+=1024*3){
      options.signal?.throwIfAborted();const rows:string[]=[];
      for(let i=start;i<Math.min(plane.length,start+1024*3);i+=3)rows.push(`${RGB8_TEXT[plane[i]]} ${RGB8_TEXT[plane[i+1]]} ${RGB8_TEXT[plane[i+2]]}`);
      const block=encoder.encode(rows.join('\n')+'\n');emitted+=block.byteLength;
      if(block.byteLength>RGB8_CUBE_TEXT_BLOCK_BYTES_V1||emitted>planned)throw Error('RGB8 LUT 匯出超過指定容量；已停止。');
      yield block;
    }
  }
  options.signal?.throwIfAborted();if(planeCount!==size||emitted!==planned)throw Error('RGB8 LUT 分片數量不完整或過多。');
}
