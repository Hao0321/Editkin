import { Euler, Matrix3, Matrix4, PerspectiveCamera, Quaternion, Vector3 } from "three";
import type { Mesh3dBuffers } from "./mesh3dGeometry";
import { Mesh3dGeometryCache } from "./mesh3dGeometry";
import { mesh3dCameraAt, mesh3dPoseAt, type Mesh3dScene, type Mesh3dObject, type Mesh3dCamera } from "./mesh3dScene";

export interface Mesh3dTexture { width: number; height: number; rgba: Uint8Array | Uint8ClampedArray; }
export interface Mesh3dDraw { mesh: Mesh3dBuffers; object: Mesh3dObject; time: number; }
export interface Mesh3dFrame { rgba: Uint8ClampedArray; depth: Float32Array; triangleCount: number; rasterizedTriangles: number; }
type Vertex = number[]; // homogeneous x,y,z,w, texture u,v, light intensity
const hex = (color: string) => [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
const clipDistance = (v: Vertex, side: number) => side === 0 ? v[0] + v[3] : side === 1 ? v[3] - v[0] : side === 2 ? v[1] + v[3] : side === 3 ? v[3] - v[1] : side === 4 ? v[2] + v[3] : v[3] - v[2];
/** Clip in homogeneous space before division, preserving UV/light attributes. */
export function clipMeshTriangle(input: Vertex[]): Vertex[] {
  let polygon = input;
  for (let side = 0; side < 6; side++) {
    if (!polygon.length) break;
    const next: Vertex[] = [];
    let a = polygon[polygon.length - 1], da = clipDistance(a, side);
    for (const b of polygon) {
      const db = clipDistance(b, side);
      if ((da >= 0) !== (db >= 0)) {
        const t = da / (da - db); next.push(a.map((value, i) => value + (b[i] - value) * t));
      }
      if (db >= 0) next.push(b);
      a = b; da = db;
    }
    polygon = next;
  }
  return polygon;
}
function modelMatrix(object: Mesh3dObject, time: number): Matrix4 {
  const pose = mesh3dPoseAt(object, time), radians = pose.rotationDegrees.map(v => v * Math.PI / 180);
  return new Matrix4().compose(new Vector3(...pose.position), new Quaternion().setFromEuler(new Euler(radians[0], radians[1], radians[2], "XYZ")), new Vector3(...pose.scale));
}
export function mesh3dProjection(camera: Mesh3dCamera, aspect: number): Matrix4 {
  if (Math.hypot(...camera.position.map((value,index)=>value-camera.target[index]))<.001 || Math.hypot(camera.position[0]-camera.target[0],camera.position[2]-camera.target[2])<.001) throw new Error("3D 相機動畫經過無效視線，請修改相機路徑");
  const result = new PerspectiveCamera(camera.verticalFovDegrees, aspect, camera.near, camera.far);
  result.position.set(...camera.position); result.lookAt(...camera.target); result.updateMatrixWorld();
  return new Matrix4().multiplyMatrices(result.projectionMatrix, result.matrixWorldInverse);
}
const edge = (ax: number, ay: number, bx: number, by: number, x: number, y: number) => (x - ax) * (by - ay) - (y - ay) * (bx - ax);

/** Shared CPU executor. Opaque Rec.709 textures, z-buffer and perspective-correct UVs. */
export function rasterizeMesh3d(scene: Mesh3dScene, camera: Mesh3dCamera, draws: Mesh3dDraw[], width: number, height: number, textures = new Map<string, Mesh3dTexture>()): Mesh3dFrame {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 3840 * 2160) throw new Error("3D 輸出尺寸超出上限");
  const triangles = draws.reduce((sum, d) => sum + d.mesh.indices.length / 3, 0);
  if (draws.length > 32 || triangles > 60000 || textures.size > 6) throw new Error("3D 場景超出有界網格／材質預算");
  const rgba = new Uint8ClampedArray(width * height * 4), depth = new Float32Array(width * height); depth.fill(Infinity);
  const background = hex(scene.background.color), grid = hex(scene.background.gridColor), spacing = scene.background.spacing * width / 540, stroke = Math.max(.6, width / 1080);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const nearX = Math.abs((x + spacing * .5) % spacing - spacing * .5), nearY = Math.abs((y + spacing * .5) % spacing - spacing * .5);
    const c = scene.background.grid && Math.min(nearX, nearY) <= stroke ? grid : background, p = (y * width + x) * 4;
    rgba[p] = c[0]; rgba[p + 1] = c[1]; rgba[p + 2] = c[2]; rgba[p + 3] = 255;
  }
  const projection = mesh3dProjection(camera, width / height), light = new Vector3(...scene.light.direction).normalize();
  let rasterizedTriangles = 0;
  for (const draw of draws) {
    const { mesh, object, time } = draw, model = modelMatrix(object, time), mvp = new Matrix4().multiplyMatrices(projection, model).elements;
    const normalMatrix = new Matrix3().getNormalMatrix(model), n = new Vector3(), color = hex(object.material.color), texture = object.material.clipId ? textures.get(object.material.clipId) : undefined;
    if (object.material.clipId && !texture) throw new Error(`3D 材質未解碼：${object.material.clipId}`);
    const vertices: Vertex[] = [];
    for (let i = 0; i < mesh.positions.length / 3; i++) {
      const x = mesh.positions[i * 3], y = mesh.positions[i * 3 + 1], z = mesh.positions[i * 3 + 2];
      n.set(mesh.normals[i * 3], mesh.normals[i * 3 + 1], mesh.normals[i * 3 + 2]).applyMatrix3(normalMatrix).normalize();
      const intensity = object.material.unlit ? 1 : Math.min(1.15, scene.light.ambient + scene.light.intensity * Math.max(0, n.dot(light)));
      vertices.push([mvp[0]*x+mvp[4]*y+mvp[8]*z+mvp[12], mvp[1]*x+mvp[5]*y+mvp[9]*z+mvp[13], mvp[2]*x+mvp[6]*y+mvp[10]*z+mvp[14], mvp[3]*x+mvp[7]*y+mvp[11]*z+mvp[15], mesh.uvs[i*2], mesh.uvs[i*2+1], intensity]);
    }
    for (let index = 0; index < mesh.indices.length; index += 3) {
      const source = [vertices[mesh.indices[index]], vertices[mesh.indices[index + 1]], vertices[mesh.indices[index + 2]]];
      // Most geometry is wholly inside the frustum; avoid polygon allocation there.
      let outside = false, rejected = false;
      for (let side = 0; side < 6; side++) {
        const negatives = source.reduce((sum, v) => sum + Number(clipDistance(v, side) < 0), 0);
        if (negatives === 3) { rejected = true; break; } if (negatives) outside = true;
      }
      if (rejected) continue;
      const polygon = outside ? clipMeshTriangle(source) : source;
      for (let k = 1; k < polygon.length - 1; k++) {
        const a = polygon[0], b = polygon[k], c = polygon[k + 1];
        const qa = 1/a[3], qb = 1/b[3], qc = 1/c[3];
        const ax = (a[0]*qa*.5+.5)*width, ay = (.5-a[1]*qa*.5)*height, bx = (b[0]*qb*.5+.5)*width, by = (.5-b[1]*qb*.5)*height, cx = (c[0]*qc*.5+.5)*width, cy = (.5-c[1]*qc*.5)*height;
        const area = edge(ax, ay, bx, by, cx, cy);
        if (Math.abs(area) < 1e-8 || (!object.material.doubleSided && area <= 0)) continue;
        const minX = Math.max(0, Math.ceil(Math.min(ax, bx, cx)-.5)), maxX = Math.min(width-1, Math.floor(Math.max(ax, bx, cx)-.5));
        const minY = Math.max(0, Math.ceil(Math.min(ay, by, cy)-.5)), maxY = Math.min(height-1, Math.floor(Math.max(ay, by, cy)-.5));
        if (minX > maxX || minY > maxY) continue;
        rasterizedTriangles++;
        const za = a[2]*qa, zb = b[2]*qb, zc = c[2]*qc;
        for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
          const wa = edge(bx, by, cx, cy, x+.5, y+.5)/area, wb = edge(cx, cy, ax, ay, x+.5, y+.5)/area, wc = 1-wa-wb;
          if (wa < -1e-9 || wb < -1e-9 || wc < -1e-9) continue;
          const d = wa*za+wb*zb+wc*zc, pixel = y*width+x;
          if (d >= depth[pixel]) continue;
          const reciprocal = wa*qa+wb*qb+wc*qc, u = (wa*a[4]*qa+wb*b[4]*qb+wc*c[4]*qc)/reciprocal, v = (wa*a[5]*qa+wb*b[5]*qb+wc*c[5]*qc)/reciprocal;
          const intensity = (wa*a[6]*qa+wb*b[6]*qb+wc*c[6]*qc)/reciprocal;
          const p = pixel*4;
          if (texture) {
            const tx = Math.max(0, Math.min(texture.width-1, Math.round(u*(texture.width-1)))), ty = Math.max(0, Math.min(texture.height-1, Math.round((1-v)*(texture.height-1)))), tp = (ty*texture.width+tx)*4;
            rgba[p] = texture.rgba[tp]*intensity; rgba[p+1] = texture.rgba[tp+1]*intensity; rgba[p+2] = texture.rgba[tp+2]*intensity;
          } else {
            const line = object.material.grid && (Math.abs((u*12)%1-.5)>.475 || Math.abs((v*12)%1-.5)>.475), pigment = line ? grid : color;
            rgba[p] = pigment[0]*intensity; rgba[p+1] = pigment[1]*intensity; rgba[p+2] = pigment[2]*intensity;
          }
          depth[pixel] = d;
        }
      }
    }
  }
  return { rgba, depth, triangleCount: triangles, rasterizedTriangles };
}
export function renderMesh3dFrame(scene: Mesh3dScene, time: number, width: number, height: number, cache: Mesh3dGeometryCache, textures = new Map<string, Mesh3dTexture>()): Mesh3dFrame {
  const segment = scene.segments.find(s => time >= s.timelineStart && time < s.timelineStart + s.duration) ?? scene.segments[scene.segments.length-1];
  const local = Math.max(0, Math.min(segment.duration, time-segment.timelineStart));
  return rasterizeMesh3d(scene, mesh3dCameraAt(segment, local), segment.objects.map(object => ({ object, time: local, mesh: cache.get(object.geometry) })), width, height, textures);
}
