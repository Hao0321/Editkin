import {describe,it,expect} from 'vitest';
import {wholeGradeAtlasV1,wholeGradeAtlasCubeV1,unpackWholeGradeAtlasV1} from './wholeGradeCubeAtlasV1';
import {parseCubeLut,sampleCubeLut} from './cubeLut';
describe('Whole grade FLOAT atlas controls',()=>{
  it('keeps red-fastest cube coordinates and explicit planar GBR packing without source quantization',()=>{
    const a=wholeGradeAtlasV1(65),v=new DataView(a.bytes.buffer),i=7+13*65+39*65*65;
    expect(Array.from(a.rgb.slice(i*3,i*3+3))).toEqual([7/64,13/64,39/64]);
    expect([v.getFloat32(i*4,true),v.getFloat32((a.pixels+i)*4,true),v.getFloat32((2*a.pixels+i)*4,true)]).toEqual([13/64,39/64,7/64]);
    expect(a.bytes.length).toBeLessThan(4*1024*1024);expect(a.gridCount).toBe(65**3);
    expect(()=>wholeGradeAtlasV1(130)).toThrow();expect(()=>wholeGradeAtlasV1(2.5)).toThrow();
  });
  it('accepts independent affine controls and rejects a task-shaped off-grid defect',()=>{
    const a=wholeGradeAtlasV1(17),out=a.rgb.map((v,i)=>i%3===0?.05+.9*v:i%3===2?.8*v:v),b=wholeGradeAtlasCubeV1(a,out,'Title "x"\n');
    expect(b.quality.maximumCodeError).toBeLessThan(.001);expect(b.quality.holdouts).toBe(512);
    const cube=parseCubeLut(b.text),point:[number,number,number]=[.313,.421,.789];
    expect(sampleCubeLut(cube,point)[0]).toBeCloseTo(.05+.9*point[0],5);expect(sampleCubeLut(cube,point)[2]).toBeCloseTo(.8*point[2],5);
    const bad=out.slice();bad[a.gridCount*3]+=.05;expect(()=>wholeGradeAtlasCubeV1(a,bad,'bad')).toThrow(/近似誤差/);
    expect(()=>wholeGradeAtlasCubeV1(a,new Float32Array(3),'short')).toThrow();
  });
  it('unpacks a16bit planar readback; swapped planes are visible and truncated output is refused',()=>{
    const a=wholeGradeAtlasV1(2),bytes=new Uint8Array(a.pixels*6),v=new DataView(bytes.buffer);
    for(let i=0;i<a.pixels;i++){v.setUint16(i*2,10000,true);v.setUint16((a.pixels+i)*2,20000,true);v.setUint16((2*a.pixels+i)*2,30000,true);}
    expect(Array.from(unpackWholeGradeAtlasV1(bytes,a).slice(0,3))).toEqual([Math.fround(30000/65535),Math.fround(10000/65535),Math.fround(20000/65535)]);
    expect(()=>unpackWholeGradeAtlasV1(bytes.slice(1),a)).toThrow(/長度/);
  });
});
