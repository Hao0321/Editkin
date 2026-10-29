import { describe, expect, it } from "vitest";
import { clipMeshTriangle, rasterizeMesh3d } from "./mesh3dRasterizer";
import type { Mesh3dBuffers } from "./mesh3dGeometry";
import type { Mesh3dObject, Mesh3dScene } from "./mesh3dScene";

const camera = { position: [0, 0, 4] as [number, number, number], target: [0, 0, 0] as [number, number, number], verticalFovDegrees: 55, near: .1, far: 20 };
const scene: Mesh3dScene = { schema: "editkin.mesh-scene/v1", enabled: true, background: { color: "#FFFFFF", gridColor: "#DAE6F8", grid: false, spacing: 72 }, light: { direction: [0, 0, 1], ambient: .4, intensity: .6 }, segments: [] };
function triangle(z: number[]): Mesh3dBuffers { return { positions: new Float32Array([-1,-1,z[0], 1,-1,z[1], 0,1,z[2]]), normals: new Float32Array([0,0,1,0,0,1,0,0,1]), uvs: new Float32Array([0,0,1,0,.5,1]), indices: new Uint32Array([0,1,2]) }; }
function object(color: string, clipId?: string): Mesh3dObject { return { id: color, name: color, geometry: { kind: "sphere", radius: 1, segments: 8 }, pose: { position: [0,0,0], rotationDegrees: [0,0,0], scale: [1,1,1] }, keyframes: [], material: { color, unlit: true, clipId } }; }
const rgb = (rgba: Uint8ClampedArray, x: number, y: number) => Array.from(rgba.slice((y*96+x)*4, (y*96+x)*4+3));
describe("mesh 3D physical depth and clipping", () => {
  it("crossing surfaces exchange front ownership and survive reverse draw order", () => {
    const red = { mesh: triangle([.7,-.7,0]), object: object("#FF0000"), time: 0 }, blue = { mesh: triangle([-.7,.7,0]), object: object("#0000FF"), time: 0 };
    const a = rasterizeMesh3d(scene, camera, [red, blue], 96, 96), b = rasterizeMesh3d(scene, camera, [blue, red], 96, 96);
    // These positions are inside both triangles, on opposite sides of their crossing.
    expect(rgb(a.rgba, 40, 61)).toEqual([255,0,0]); expect(rgb(a.rgba, 55, 61)).toEqual([0,0,255]);
    expect(a.rgba).toEqual(b.rgba);
    // An average-depth painter must choose a single front face and cannot pass both probes.
    const painter = rasterizeMesh3d(scene, camera, [{ ...red, mesh: triangle([0,0,0]) }], 96, 96);
    expect(rgb(painter.rgba,55,61)).not.toEqual(rgb(a.rgba,55,61));
  });
  it("clips all six homogeneous planes instead of dividing vertices behind the eye", () => {
    const vertices = clipMeshTriangle([[-.5,-.5,0,1,0,0,1], [.5,-.5,0,1,1,0,1], [0,.5,-2,1,.5,1,1]]);
    expect(vertices).toHaveLength(4);
    for (const v of vertices) expect(v[2]).toBeGreaterThanOrEqual(-v[3]-1e-9);
    expect(clipMeshTriangle([[0,0,2,1,0,0,1],[.5,0,2,1,0,0,1],[0,.5,2,1,0,0,1]])).toEqual([]);
  });
  it("keeps texture corners consistent and rejects missing decoded sources", () => {
    const draw = { mesh: triangle([0,0,0]), object: object("#FFFFFF", "footage"), time: 0 };
    expect(() => rasterizeMesh3d(scene, camera, [draw],96,96)).toThrow("材質未解碼");
    const texture = { width: 2, height: 2, rgba: new Uint8Array([255,0,0,255,0,255,0,255,0,0,255,255,255,255,0,255]) };
    const frame = rasterizeMesh3d(scene,camera,[draw],96,96,new Map([["footage",texture]]));
    expect(rgb(frame.rgba,37,62)).toEqual([0,0,255]); expect(rgb(frame.rgba,58,62)).toEqual([255,255,0]); expect(rgb(frame.rgba,46,35)).toEqual([255,0,0]);
  });
  it("corrects UV on a slanted plane rather than interpolating it in screen space",()=>{
    const mesh:Mesh3dBuffers={positions:new Float32Array([-1,-1,1,1,-1,-1,1,1,-1,-1,1,1]),normals:new Float32Array(12),uvs:new Float32Array([0,0,1,0,1,1,0,1]),indices:new Uint32Array([0,1,2,0,2,3])};
    const gradient=new Uint8Array(256*4);for(let i=0;i<256;i++){gradient[i*4]=i;gradient[i*4+3]=255;}
    // The screen centre ray hits world x=0, so texture u=0.5; affine screen UV gives 0.625.
    const frame=rasterizeMesh3d(scene,camera,[{mesh,object:object("#FFFFFF","tilt"),time:0}],96,96,new Map([["tilt",{width:256,height:1,rgba:gradient}]]));
    expect(rgb(frame.rgba,48,48)[0]).toBeGreaterThanOrEqual(126);expect(rgb(frame.rgba,48,48)[0]).toBeLessThanOrEqual(132);
  });
});
