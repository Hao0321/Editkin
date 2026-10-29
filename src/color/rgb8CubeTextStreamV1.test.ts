import{describe,it,expect}from'vitest';
import{rgb8CubeTextBlocksV1,RGB8_CUBE_TEXT_MAX_BYTES_V1}from'./rgb8CubeTextStreamV1';
import{parseCubeFile,sampleCubeLut}from'./cubeLut';
const collect=async(iterator:AsyncIterable<Uint8Array>)=>{let text='';for await(const block of iterator)text+=new TextDecoder().decode(block);return text;};
describe('Bounded blue-plane RGB8cube text',()=>{
  it('writes red-fastest RGB rows readable by the existing consumer without changing byte colours',async()=>{
    const planes=[new Uint8Array([0,1,2,255,3,4,5,255,6,7,8,255]),new Uint8Array([9,10,11,12,13,14,15,16,17,255,255,255])];
    const text=await collect(rgb8CubeTextBlocksV1(2,planes,{maximumBytes:1024,title:'Owned RGB8 control'})),cube=parseCubeFile(text);expect(cube.kind).toBe('3d');if(cube.kind!=='3d')throw Error('wrong kind');
    expect(sampleCubeLut(cube,[1,0,0]).map(v=>Math.round(v*255))).toEqual([255,3,4]);expect(sampleCubeLut(cube,[0,1,1]).map(v=>Math.round(v*255))).toEqual([15,16,17]);expect(text.split('\n').filter(s=>/^\d/.test(s))).toHaveLength(8);
  });
  it('roundtrips every output code0..255 through the standard parser',async()=>{
    const plane=new Uint8Array(16*16*3);for(let i=0;i<256;i++){plane[i*3]=i;plane[i*3+1]=255-i;plane[i*3+2]=(i*13)%256;}
    const text=await collect(rgb8CubeTextBlocksV1(16,Array.from({length:16},()=>plane),{maximumBytes:1024*1024})),cube=parseCubeFile(text);
    for(let i=0;i<plane.length;i++){expect(Math.round(cube.values[i]*255)).toBe(plane[i]);expect(Math.trunc(Math.fround(cube.values[i]*255))).toBe(plane[i]);}
  });
  it('emits a256table lazily using only one copied plane, with no full16million-row output',async()=>{
    const plane=Buffer.alloc(256*256*3,127);let produced=0,closed=false;
    async function* source(){try{for(let i=0;i<256;i++){produced++;yield plane;}}finally{closed=true;}}
    const stream=rgb8CubeTextBlocksV1(256,source(),{maximumBytes:RGB8_CUBE_TEXT_MAX_BYTES_V1});
    expect(new TextDecoder().decode((await stream.next()).value)).toContain('LUT_3D_SIZE 256');expect(produced).toBe(0);
    const first=(await stream.next()).value!;expect(first.byteLength).toBeLessThanOrEqual(65536);expect(produced).toBe(1);plane.fill(255);
    const second=(await stream.next()).value!;expect(new TextDecoder().decode(second)).toContain('0.499020');expect(new TextDecoder().decode(first)).toContain('0.499020');await stream.return(undefined);expect(closed).toBe(true);expect(produced).toBe(1);
  });
  it('rejects impossible budgets before pulling a plane, and rejects missing/extra or aliased planes',async()=>{
    let pulled=0;function* source(){pulled++;yield new Uint8Array(12);}
    await expect(collect(rgb8CubeTextBlocksV1(256,source(),{maximumBytes:64*1024*1024}))).rejects.toThrow(/容量/);expect(pulled).toBe(0);
    await expect(collect(rgb8CubeTextBlocksV1(2,[new Uint8Array(12)],{maximumBytes:1024}))).rejects.toThrow(/數量/);
    await expect(collect(rgb8CubeTextBlocksV1(2,[new Uint8Array(12),new Uint8Array(12),new Uint8Array(12)],{maximumBytes:1024}))).rejects.toThrow(/數量/);
    await expect(collect(rgb8CubeTextBlocksV1(2,[new Uint8Array(11)],{maximumBytes:1024}))).rejects.toThrow(/長度/);
    await expect(collect(rgb8CubeTextBlocksV1(2,[new Uint8Array(new SharedArrayBuffer(12))],{maximumBytes:1024}))).rejects.toThrow(/格式/);
    await expect(collect(rgb8CubeTextBlocksV1(2,[],{maximumBytes:1024,title:'中文'}))).rejects.toThrow(/標題/);
  });
  it('cancellation after one block closes its producer and emits no more data',async()=>{
    const controller=new AbortController();let closed=false;async function* source(){try{yield new Uint8Array(256*256*3);}finally{closed=true;}}
    const stream=rgb8CubeTextBlocksV1(256,source(),{maximumBytes:RGB8_CUBE_TEXT_MAX_BYTES_V1,signal:controller.signal});await stream.next();await stream.next();controller.abort();await expect(stream.next()).rejects.toThrow();expect(closed).toBe(true);
  });
});
