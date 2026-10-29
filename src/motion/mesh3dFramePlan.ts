import { Euler, Matrix3, Matrix4, PerspectiveCamera, Quaternion, Vector3 } from "three";
import type { Mesh3dBuffers } from "./mesh3dGeometry";
import { mesh3dPoseAt, type Mesh3dCamera, type Mesh3dMaterial, type Mesh3dObject, type Mesh3dScene } from "./mesh3dScene";
import { mesh3dDrawBlendedV1, mesh3dMaterialExtendedV1, mesh3dMeshBoundsV1, mesh3dSceneExtendedV1 } from "./mesh3dShading";
import type { Mesh3dKernelDrawV1, Mesh3dKernelJobV1, Mesh3dKernelLightV1, Mesh3dKernelMaterialV1, Mesh3dKernelPassV1, Mesh3dKernelPostV1, Mesh3dKernelShadowV1, Mesh3dKernelTextureV1 } from "./mesh3dKernel";

/**
 * Frame planner (polish 2026-10-23): turns a scene, camera and draws into a kernel job
 * (mesh3dKernel.ts). Vertex work, validation and ordering stay on the calling thread with
 * the original arithmetic; the kernel only rasterizes, shades and filters.
 */
export interface Mesh3dTexture { width: number; height: number; rgba: Uint8Array | Uint8ClampedArray; }
export interface Mesh3dDraw { mesh: Mesh3dBuffers; object: Mesh3dObject; time: number; }
export interface Mesh3dFrame { rgba: Uint8ClampedArray; depth: Float32Array; depthPrecise?: Float64Array; triangleCount: number; rasterizedTriangles: number; hdr?: Float32Array; }
/** `hdr`: also return unclamped RGB (post effects); only honoured for scenes using the extended shading path. */
export interface Mesh3dRasterOptionsV1 { depthPrecision?: "float32" | "float64"; hdr?: boolean; }

/** Scene budgets. One frame draws at most this many objects, triangles and decoded textures. */
export const MESH3D_MAX_OBJECTS = 128;
export const MESH3D_MAX_TEXTURES = 16;
export const MESH3D_MAX_SCENE_TRIANGLES = 200_000;

type Typed = Float64Array | Float32Array | Uint8Array | Uint8ClampedArray | Uint16Array | Uint32Array | Int32Array;
type TypedCtor<T extends Typed> = { new (length: number): T; new (buffer: ArrayBufferLike, byteOffset: number, length: number): T; BYTES_PER_ELEMENT: number };
/** Where a plan's arrays live: plain memory for one thread, shared memory for worker threads. */
export interface Mesh3dAllocatorV1 {
  /** Zeroed, frame lifetime. */
  frame<T extends Typed>(ctor: TypedCtor<T>, length: number): T;
  /** Read-only frame-lifetime view of caller data (one thread: the data itself). */
  share<T extends Typed>(source: T): T;
  /** Reused across frames by name; contents unspecified. */
  scratch<T extends Typed>(name: string, ctor: TypedCtor<T>, length: number): T;
  /** Part of the returned frame; `result` hands the caller its own copy where needed. */
  output<T extends Typed>(name: string, ctor: TypedCtor<T>, length: number): T;
  result<T extends Typed>(buffer: T): T;
}
const scratchPool = new Map<string, Typed>();
export const mesh3dSerialAllocatorV1: Mesh3dAllocatorV1 = {
  frame: (ctor, length) => new ctor(length),
  share: source => source,
  scratch: (name, ctor, length) => {
    const found = scratchPool.get(name);
    if (found instanceof ctor && found.length === length) return found as never;
    const created = new ctor(length); scratchPool.set(name, created); return created;
  },
  output: (_name, ctor, length) => new ctor(length),
  result: buffer => buffer,
};

const hex = (color: string) => [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
const rgb01 = (color: string): [number, number, number] => [parseInt(color.slice(1, 3), 16) / 255, parseInt(color.slice(3, 5), 16) / 255, parseInt(color.slice(5, 7), 16) / 255];
const STRIDE = 13;

function modelMatrix(object: Mesh3dObject, time: number): Matrix4 {
  const pose = mesh3dPoseAt(object, time), radians = pose.rotationDegrees.map(v => v * Math.PI / 180);
  return new Matrix4().compose(new Vector3(...pose.position), new Quaternion().setFromEuler(new Euler(radians[0], radians[1], radians[2], "XYZ")), new Vector3(...pose.scale));
}
/** Opt-in anchor projection shares this exact model transform; legacy raster calls are unchanged. */
export const mesh3dObjectMatrixAtV1 = modelMatrix;
/** View-projection. `roll` (degrees) turns the camera about its line of sight: positive rolls it counter-clockwise, so the image turns clockwise. */
export function mesh3dProjection(camera: Mesh3dCamera, aspect: number): Matrix4 {
  if (Math.hypot(...camera.position.map((value,index)=>value-camera.target[index]))<.001 || Math.hypot(camera.position[0]-camera.target[0],camera.position[2]-camera.target[2])<.001) throw new Error("3D 相機動畫經過無效視線，請修改相機路徑");
  const result = new PerspectiveCamera(camera.verticalFovDegrees, aspect, camera.near, camera.far);
  result.position.set(...camera.position); result.lookAt(...camera.target);
  if (camera.roll) result.rotateZ(camera.roll * Math.PI / 180);
  result.updateMatrixWorld();
  return new Matrix4().multiplyMatrices(result.projectionMatrix, result.matrixWorldInverse);
}

/** Back to front by the NDC depth of each object's bounds centre (stable for ties). */
function sortByDepth(draws: Mesh3dDraw[], projection: Matrix4): Mesh3dDraw[] {
  const keyed = draws.map(draw => {
    const box = mesh3dMeshBoundsV1(draw.mesh), centre = new Vector3((box[0] + box[3]) / 2, (box[1] + box[4]) / 2, (box[2] + box[5]) / 2)
      .applyMatrix4(modelMatrix(draw.object, draw.time)).applyMatrix4(projection);
    return { draw, depth: centre.z };
  });
  return keyed.sort((a, b) => b.depth - a.depth).map(k => k.draw);
}
/** Conservative rows touched by a draw: projected vertex bounds when every vertex is in front of the eye. */
function rowRange(vertices: Float64Array, stride: number, height: number): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (let o = 0; o < vertices.length; o += stride) {
    const w = vertices[o + 3];
    if (!(w > 1e-9)) return [0, height - 1];
    const y = (.5 - vertices[o + 1] / w * .5) * height;
    if (y < lo) lo = y; if (y > hi) hi = y;
  }
  return lo > hi ? [1, 0] : [Math.max(0, Math.floor(lo) - 2), Math.min(height - 1, Math.ceil(hi) + 2)];
}

function materialRecord(scene: Mesh3dScene, m: Mesh3dMaterial, width: number, shadow: boolean): Mesh3dKernelMaterialV1 {
  const base = rgb01(m.color), gridColor = rgb01(scene.background.gridColor);
  const stripeA = m.stripes ? rgb01(m.stripes.colors[0]) : base, stripeB = m.stripes ? rgb01(m.stripes.colors[1]) : base;
  const stripeCos = m.stripes ? Math.cos(m.stripes.angleDegrees * Math.PI / 180) * m.stripes.count : 0, stripeSin = m.stripes ? Math.sin(m.stripes.angleDegrees * Math.PI / 180) * m.stripes.count : 0;
  const gradA = m.gradient ? rgb01(m.gradient.colors[0]) : base, gradB = m.gradient ? rgb01(m.gradient.colors[1]) : base;
  const emissive = m.emissive ? rgb01(m.emissive.color).map(c => c * m.emissive!.strength) : undefined;
  const rim = m.edgeLight ? rgb01(m.edgeLight.color).map(c => c * m.edgeLight!.strength) : undefined;
  const specStrength = m.specular?.strength ?? 0, shininess = m.specular?.shininess ?? 1;
  const reflection = m.reflection, sky = reflection ? rgb01(reflection.sky) : base, horizon = reflection ? rgb01(reflection.horizon) : base, ground = reflection ? rgb01(reflection.ground) : base;
  const wire = m.wireframe, wireColor = wire ? rgb01(wire.color) : base;
  // Soft specular: GGX with the material roughness (or the Blinn-Phong equivalent), widened by the key light's size.
  // A positional key widens per pixel by its apparent size instead (mesh3dKernel).
  const size = (scene.light.size ?? 0) * Math.PI / 180, hasGgx = m.roughness !== undefined || size > 0;
  const alpha = m.roughness !== undefined ? Math.max(.02, m.roughness * m.roughness) : Math.sqrt(2 / (shininess + 2)), widened = scene.light.distance !== undefined ? alpha : Math.min(1, alpha + Math.tan(size) * .5);
  const style = m.gridStyle, cells = style ? (typeof style.cells === "number" ? [style.cells, style.cells] : style.cells) : [1, 1], styleColor = style?.color ? rgb01(style.color) : gridColor;
  return {
    unlit: m.unlit, doubleSided: Boolean(m.doubleSided),
    baseR: base[0], baseG: base[1], baseB: base[2], gridR: gridColor[0], gridG: gridColor[1], gridB: gridColor[2],
    hasStripes: Boolean(m.stripes), sAr: stripeA[0], sAg: stripeA[1], sAb: stripeA[2], sBr: stripeB[0] - stripeA[0], sBg: stripeB[1] - stripeA[1], sBb: stripeB[2] - stripeA[2], stripeCos, stripeSin,
    hasGradient: Boolean(m.gradient), gAr: gradA[0], gAg: gradA[1], gAb: gradA[2], gBr: gradB[0] - gradA[0], gBg: gradB[1] - gradA[1], gBb: gradB[2] - gradA[2],
    hasGrid: Boolean(m.grid),
    hasWire: Boolean(wire), wireFill: Boolean(wire?.fill), wireR: wireColor[0], wireG: wireColor[1], wireB: wireColor[2], wireHalf: wire ? wire.width * width / 1080 / 2 : 0, divU: wire?.divisions[0] ?? 1, divV: wire?.divisions[1] ?? 1,
    hasEmissive: Boolean(emissive), emR: emissive?.[0] ?? 0, emG: emissive?.[1] ?? 0, emB: emissive?.[2] ?? 0,
    hasRim: Boolean(rim), rimR: rim?.[0] ?? 0, rimG: rim?.[1] ?? 0, rimB: rim?.[2] ?? 0, rimPower: m.edgeLight?.power ?? 1,
    specStrength, shininess,
    hasReflection: Boolean(reflection), reflK: reflection?.strength ?? 0, skyR: sky[0], skyG: sky[1], skyB: sky[2], horR: horizon[0], horG: horizon[1], horB: horizon[2], grR: ground[0], grG: ground[1], grB: ground[2],
    hasGgx, ggxAlpha: alpha, ggxA2: widened * widened, ggxNorm: (alpha / widened) * (alpha / widened), roughness: m.roughness ?? 0,
    hasGridStyle: Boolean(style), gridCellsU: cells[0], gridCellsV: cells[1], gridHalf: style ? style.lineWidthPx * width / 1080 / 2 : 0, gsR: styleColor[0], gsG: styleColor[1], gsB: styleColor[2],
    gridFadeStart: style?.fade?.start ?? 0, gridFadeEnd: style?.fade?.end ?? 0,
    receiveShadow: shadow && (m.receiveShadow ?? !m.unlit), aoWeight: m.unlit ? 0 : 255,
  };
}
function lightRecord(scene: Mesh3dScene, cameraPosition: readonly number[]): Mesh3dKernelLightV1 {
  // Direction points toward the light, as in the original path.
  const L = scene.light.direction, ll = Math.hypot(L[0], L[1], L[2]) || 1;
  const fill = scene.light.fill, fl = fill ? Math.hypot(...fill.direction) || 1 : 1, fillColor = fill ? rgb01(fill.color) : [0, 0, 0];
  const hemi = scene.light.hemisphere, hemiSky = hemi ? rgb01(hemi.sky) : [0, 0, 0], hemiGround = hemi ? rgb01(hemi.ground) : [0, 0, 0];
  const size = (scene.light.size ?? 0) * Math.PI / 180;
  return {
    lx: L[0] / ll, ly: L[1] / ll, lz: L[2] / ll, keyI: scene.light.intensity, ambient: scene.light.ambient,
    hasFill: Boolean(fill), fx: fill ? fill.direction[0] / fl : 0, fy: fill ? fill.direction[1] / fl : 0, fz: fill ? fill.direction[2] / fl : 0, fillR: fillColor[0], fillG: fillColor[1], fillB: fillColor[2], fillI: fill?.intensity ?? 0,
    hasHemi: Boolean(hemi), hemiI: hemi?.intensity ?? 0, hgR: hemiGround[0], hgG: hemiGround[1], hgB: hemiGround[2], hdR: hemiSky[0] - hemiGround[0], hdG: hemiSky[1] - hemiGround[1], hdB: hemiSky[2] - hemiGround[2],
    camX: cameraPosition[0], camY: cameraPosition[1], camZ: cameraPosition[2], wrap: size > 0 ? Math.sin(size) * .5 : 0,
    ...pointLight(scene, L[0] / ll, L[1] / ll, L[2] / ll, size),
  };
}
/** `light.distance`: the key becomes a sphere light at direction × distance from the world origin, of angular radius `size`. */
function pointLight(scene: Mesh3dScene, lx: number, ly: number, lz: number, size: number) {
  const distance = scene.light.distance;
  if (distance === undefined) return { hasPoint: false, ptX: 0, ptY: 0, ptZ: 0, ptR: 0, falloffRef: 1 };
  const radius = distance * Math.tan(size);
  return { hasPoint: true, ptX: lx * distance, ptY: ly * distance, ptZ: lz * distance, ptR: radius, falloffRef: distance * distance + radius * radius };
}

/** Per-pixel draw: clip/UV/normal/world/gradient attributes per vertex (original mesh3dShadeDrawV1 arithmetic). */
function extendedVertices(draw: Mesh3dDraw, model: Matrix4, mvp: Matrix4, alloc: Mesh3dAllocatorV1): Float64Array {
  const { mesh, object } = draw, m = object.material, e = mvp.elements, mm = model.elements, nm = new Matrix3().getNormalMatrix(model).elements;
  const vertexCount = mesh.positions.length / 3, attributes = alloc.frame(Float64Array, vertexCount * STRIDE);
  const box = m.gradient ? mesh3dMeshBoundsV1(mesh) : undefined, axis = m.gradient ? { x: 0, y: 1, z: 2 }[m.gradient.axis] : 0;
  for (let i = 0; i < vertexCount; i++) {
    const x = mesh.positions[i * 3], y = mesh.positions[i * 3 + 1], z = mesh.positions[i * 3 + 2], o = i * STRIDE;
    attributes[o] = e[0] * x + e[4] * y + e[8] * z + e[12]; attributes[o + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    attributes[o + 2] = e[2] * x + e[6] * y + e[10] * z + e[14]; attributes[o + 3] = e[3] * x + e[7] * y + e[11] * z + e[15];
    attributes[o + 4] = mesh.uvs[i * 2]; attributes[o + 5] = mesh.uvs[i * 2 + 1];
    const a = mesh.normals[i * 3], b = mesh.normals[i * 3 + 1], c = mesh.normals[i * 3 + 2];
    const nx = nm[0] * a + nm[3] * b + nm[6] * c, ny = nm[1] * a + nm[4] * b + nm[7] * c, nz = nm[2] * a + nm[5] * b + nm[8] * c, nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    attributes[o + 6] = nx / nl; attributes[o + 7] = ny / nl; attributes[o + 8] = nz / nl;
    attributes[o + 9] = mm[0] * x + mm[4] * y + mm[8] * z + mm[12]; attributes[o + 10] = mm[1] * x + mm[5] * y + mm[9] * z + mm[13]; attributes[o + 11] = mm[2] * x + mm[6] * y + mm[10] * z + mm[14];
    attributes[o + 12] = box ? (mesh.positions[i * 3 + axis] - box[axis]) / Math.max(1e-9, box[axis + 3] - box[axis]) : 0;
  }
  return attributes;
}
/** Original per-vertex path: clip position, UV and the vertex light intensity. */
function legacyVertices(scene: Mesh3dScene, draw: Mesh3dDraw, model: Matrix4, projection: Matrix4, light: Vector3, alloc: Mesh3dAllocatorV1): Float64Array {
  const { mesh, object } = draw, mvp = new Matrix4().multiplyMatrices(projection, model).elements;
  const normalMatrix = new Matrix3().getNormalMatrix(model), n = new Vector3(), count = mesh.positions.length / 3, out = alloc.frame(Float64Array, count * 7);
  for (let i = 0; i < count; i++) {
    const x = mesh.positions[i * 3], y = mesh.positions[i * 3 + 1], z = mesh.positions[i * 3 + 2], o = i * 7;
    n.set(mesh.normals[i * 3], mesh.normals[i * 3 + 1], mesh.normals[i * 3 + 2]).applyMatrix3(normalMatrix).normalize();
    const intensity = object.material.unlit ? 1 : Math.min(1.15, scene.light.ambient + scene.light.intensity * Math.max(0, n.dot(light)));
    out[o] = mvp[0]*x+mvp[4]*y+mvp[8]*z+mvp[12]; out[o + 1] = mvp[1]*x+mvp[5]*y+mvp[9]*z+mvp[13]; out[o + 2] = mvp[2]*x+mvp[6]*y+mvp[10]*z+mvp[14]; out[o + 3] = mvp[3]*x+mvp[7]*y+mvp[11]*z+mvp[15];
    out[o + 4] = mesh.uvs[i*2]; out[o + 5] = mesh.uvs[i*2+1]; out[o + 6] = intensity;
  }
  return out;
}

const FILTERS = { nearest: 1, bilinear: 2, mipmap: 3 } as const;
function textureRecord(cache: Map<string, Mesh3dKernelTextureV1>, clipId: string, source: Mesh3dTexture, material: Mesh3dMaterial, alloc: Mesh3dAllocatorV1): Mesh3dKernelTextureV1 {
  const filter = material.texture ? FILTERS[material.texture.filter] : 0, alpha = Boolean(material.texture?.alpha), key = `${clipId}\u0000${filter}\u0000${alpha}`;
  const found = cache.get(key);
  if (found) return found;
  const shared = cache.get(`${clipId}\u0000rgba`)?.rgba ?? alloc.share(source.rgba);
  const record: Mesh3dKernelTextureV1 = { width: source.width, height: source.height, rgba: shared, filter, alpha, mips: [], mipWidth: [source.width], mipHeight: [source.height] };
  if (filter === 3) {
    record.mips.push(new Float32Array(0));
    let w = source.width, h = source.height;
    while ((w > 1 || h > 1) && record.mips.length < 16) {
      w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
      record.mipWidth.push(w); record.mipHeight.push(h);
      record.mips.push(alloc.scratch(`mip:${clipId}:${alpha}:${record.mips.length}`, Float32Array, w * h * 4));
    }
  }
  cache.set(key, record); cache.set(`${clipId}\u0000rgba`, record);
  return record;
}

export interface Mesh3dPlanPassV1 { camera: Mesh3dCamera; draws: Mesh3dDraw[]; }
export interface Mesh3dPlanPostV1 { post: NonNullable<Mesh3dScene["post"]>; camera: Mesh3dCamera; gap?: { sx: number; sy: number }; centre: number; }
export interface Mesh3dFramePlanV1 { job: Mesh3dKernelJobV1; triangleCount: number; finish(rasterized: number): Mesh3dFrame; }

/**
 * Orthographic shadow map of the key light fitted to the casters' light-space bounds
 * (receivers outside it are lit). Buffers are sized by `mapSize` only, so every pass and
 * frame reuses them.
 */
function shadowSetup(scene: Mesh3dScene, records: Mesh3dKernelDrawV1[], alloc: Mesh3dAllocatorV1): Mesh3dKernelShadowV1 | undefined {
  const settings = scene.light.shadow;
  if (!settings) return undefined;
  const casters = records.filter(r => r.cast);
  if (!casters.length) return undefined;
  const L = scene.light.direction, ll = Math.hypot(L[0], L[1], L[2]) || 1, fx = -L[0] / ll, fy = -L[1] / ll, fz = -L[2] / ll;
  // Light basis: forward away from the light; right = forward × up, up' = right × forward.
  const vertical = Math.abs(fy) >= .99, upY = vertical ? 0 : 1, upZ = vertical ? 1 : 0;
  let rx = fy * upZ - fz * upY, ry = -fx * upZ, rz = fx * upY; const rl = Math.hypot(rx, ry, rz); rx /= rl; ry /= rl; rz /= rl;
  const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, zMin = Infinity;
  for (const r of casters) {
    const V = r.vertices, xyz = alloc.frame(Float64Array, V.length / STRIDE * 3);
    for (let i = 0, o = 0; o < V.length; i += 3, o += STRIDE) {
      const px = V[o + 9], py = V[o + 10], pz = V[o + 11];
      const a = px * rx + py * ry + pz * rz, b = px * ux + py * uy + pz * uz, c = px * fx + py * fy + pz * fz;
      xyz[i] = a; xyz[i + 1] = b; xyz[i + 2] = c;
      if (a < x0) x0 = a; if (a > x1) x1 = a; if (b < y0) y0 = b; if (b > y1) y1 = b; if (c < zMin) zMin = c;
    }
    r.shadowXYZ = xyz;
  }
  const size = settings.mapSize ?? 1024, pad = 6, extent = Math.max(x1 - x0, y1 - y0, 1e-6), texel = extent / (size - 2 * pad), invTexel = 1 / texel;
  const width = Math.min(size, Math.ceil((x1 - x0) * invTexel) + 2 * pad), height = Math.min(size, Math.ceil((y1 - y0) * invTexel) + 2 * pad);
  const originX = x0 - pad * texel, originY = y0 - pad * texel;
  for (const r of casters) {
    const xyz = r.shadowXYZ!;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < xyz.length; i += 3) {
      xyz[i] = (xyz[i] - originX) * invTexel; const y = xyz[i + 1] = (xyz[i + 1] - originY) * invTexel;
      if (y < lo) lo = y; if (y > hi) hi = y;
    }
    r.shadowYMin = Math.max(0, Math.floor(lo) - 1); r.shadowYMax = Math.min(height - 1, Math.ceil(hi) + 1);
  }
  const levels: Mesh3dKernelShadowV1["levels"] = [];
  for (let w = width, h = height, capacity = size, k = 0; ; k++) {
    levels.push({ width: w, height: h, depth: alloc.scratch(`shadow-depth:${k}`, Float32Array, capacity * capacity), id: alloc.scratch(`shadow-id:${k}`, Uint16Array, capacity * capacity) });
    if ((w <= 4 && h <= 4) || k >= 9) break;
    w = Math.ceil(w / 2); h = Math.ceil(h / 2); capacity = Math.ceil(capacity / 2);
  }
  return { rx, ry, rz, ux, uy, uz, fx, fy, fz, x0: originX, y0: originY, invTexel, zMin,
    softness: Math.tan(settings.softness * Math.PI / 180), strength: settings.strength, bias: texel * 1.5, normalOffset: texel * 2, maxRadius: Math.min(256, 2.5 * (1 << (levels.length - 1))), levels };
}

/**
 * Plan one frame: `passes` are the raster passes (motion-blur sub-frames, or one), `post`
 * the post chain. Validation runs in the original order, so errors are unchanged.
 */
export function mesh3dPlanFrameV1(scene: Mesh3dScene, passes: Mesh3dPlanPassV1[], width: number, height: number, textures: Map<string, Mesh3dTexture>,
  options: Mesh3dRasterOptionsV1, post: Mesh3dPlanPostV1 | undefined, alloc: Mesh3dAllocatorV1): Mesh3dFramePlanV1 {
  const hdrOnly = Boolean(post), count = passes.length, multi = count > 1;
  const extendedScene = mesh3dSceneExtendedV1(scene), shadowScene = Boolean(scene.light.shadow);
  const kernelPasses: Mesh3dKernelPassV1[] = [], textureRecords = new Map<string, Mesh3dKernelTextureV1>();
  let triangleCount = 0, hdrRequested = false, depthPrecise: Float64Array | undefined;
  for (let p = 0; p < count; p++) {
    const { camera, draws } = passes[p];
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 3840 * 2160) throw new Error("3D 輸出尺寸超出上限");
    const triangles = draws.reduce((sum, d) => sum + d.mesh.indices.length / 3, 0);
    if (draws.length > MESH3D_MAX_OBJECTS || triangles > MESH3D_MAX_SCENE_TRIANGLES || textures.size > MESH3D_MAX_TEXTURES) throw new Error("3D 場景超出有界網格／材質預算");
    if (options.depthPrecision !== undefined && !["float32", "float64"].includes(options.depthPrecision)) throw new Error("3D 深度精度格式不合法");
    triangleCount = triangles;
    const projection = mesh3dProjection(camera, width / height), light = new Vector3(...scene.light.direction).normalize();
    hdrRequested = extendedScene && Boolean(hdrOnly || options.hdr);
    // Blended draws composite last, back to front. Extended scenes also shade opaque draws front to
    // back so the depth test rejects hidden pixels before they are shaded.
    const blended = draws.filter(d => mesh3dDrawBlendedV1(d.object, d.mesh)), opaque = blended.length ? draws.filter(d => !blended.includes(d)) : draws;
    const ordered = extendedScene ? [...sortByDepth(opaque, projection).reverse(), ...sortByDepth(blended, projection)]
      : blended.length ? [...opaque, ...sortByDepth(blended, projection)] : draws;
    const lightRec = lightRecord(scene, camera.position), records: Mesh3dKernelDrawV1[] = [];
    ordered.forEach((draw, index) => {
      const material = draw.object.material, clipId = material.clipId, source = clipId ? textures.get(clipId) : undefined;
      if (clipId && !source) throw new Error(`3D 材質未解碼：${clipId}`);
      const model = modelMatrix(draw.object, draw.time), isBlended = blended.includes(draw);
      const texture = source ? textureRecord(textureRecords, clipId!, source, material, alloc) : undefined;
      const extendedDraw = extendedScene || mesh3dMaterialExtendedV1(material) || Boolean(draw.mesh.mask) || Boolean(draw.mesh.uvUntextured);
      const vertices = extendedDraw ? extendedVertices(draw, model, new Matrix4().multiplyMatrices(projection, model), alloc) : legacyVertices(scene, draw, model, projection, light, alloc);
      const [yMin, yMax] = rowRange(vertices, extendedDraw ? STRIDE : 7, height);
      records.push({
        kind: extendedDraw ? 1 : 0, id: index, vertices, indices: alloc.share(draw.mesh.indices), doubleSided: Boolean(material.doubleSided), yMin, yMax,
        color: hex(material.color), grid: Boolean(material.grid), texture,
        mat: extendedDraw ? materialRecord(scene, material, width, shadowScene) : undefined,
        mask: draw.mesh.mask ? { levels: draw.mesh.mask.levels.map(l => ({ width: l.width, height: l.height, alpha: alloc.share(l.alpha) })), repeat: draw.mesh.mask.repeat } : undefined,
        // Casters default to opaque draws and alpha-textured ones (alpha-tested in the shadow map); masks and line-only wireframes do not cast.
        cast: shadowScene && extendedDraw && (material.castShadow ?? (!isBlended || Boolean(texture?.alpha))), shadowYMin: 0, shadowYMax: -1, alphaCast: Boolean(texture?.alpha),
      });
    });
    kernelPasses.push({ draws: records, light: lightRec, shadow: shadowSetup(scene, records, alloc) });
  }
  const n = width * height, single = !multi;
  const rgba = alloc.output("rgba", Uint8ClampedArray, n * 4);
  const depth = single ? alloc.output("depth", Float32Array, n) : alloc.scratch("pass-depth", Float32Array, n);
  if (options.depthPrecision === "float64") depthPrecise = single ? alloc.output("depthPrecise", Float64Array, n) : alloc.scratch("pass-depth-precise", Float64Array, n);
  const hdr = hdrRequested ? (hdrOnly ? alloc.scratch("hdr", Float32Array, n * 3) : alloc.output("hdr", Float32Array, n * 3)) : undefined;
  const refDepth = multi ? alloc.output("depth", Float32Array, n) : undefined, refPrecise = multi && depthPrecise ? alloc.output("depthPrecise", Float64Array, n) : undefined;
  const sum = multi ? alloc.scratch("sum", Float32Array, n * 3) : undefined;
  const radial = scene.background.radial;
  const job: Mesh3dKernelJobV1 = {
    width, height, passes: kernelPasses, centre: post?.centre ?? 0,
    background: { color: hex(scene.background.color), gridColor: hex(scene.background.gridColor), spacing: scene.background.spacing, grid: scene.background.grid, extended: extendedScene,
      ...(radial ? { radial: { color: hex(radial.color), center: [...radial.center], radius: radial.radius, strength: radial.strength } } : {}) },
    rgba, writeRgba: !(hdrOnly && hdr), depth, depthPrecise, hdr, refDepth, refPrecise, sum,
    textures: [...new Set(textureRecords.values())],
  };
  if (post) job.post = postRecord(post, width, height, multi ? sum! : hdr!, multi ? refDepth! : depth, rgba, job, alloc);
  return {
    job, triangleCount,
    finish(rasterized: number): Mesh3dFrame {
      if (post) {
        const precise = multi ? refPrecise : depthPrecise;
        return { rgba: alloc.result(rgba), depth: alloc.result(multi ? refDepth! : depth), ...(precise ? { depthPrecise: alloc.result(precise) } : {}), triangleCount, rasterizedTriangles: rasterized };
      }
      return { rgba: alloc.result(rgba), depth: alloc.result(depth), ...(depthPrecise ? { depthPrecise: alloc.result(depthPrecise) } : {}), triangleCount, rasterizedTriangles: rasterized, ...(hdr ? { hdr: alloc.result(hdr) } : {}) };
    },
  };
}
function postRecord(plan: Mesh3dPlanPostV1, w: number, h: number, color: Float32Array, depth: Float32Array, out: Uint8ClampedArray, job: Mesh3dKernelJobV1, alloc: Mesh3dAllocatorV1): Mesh3dKernelPostV1 {
  const post = plan.post, n = w * h, qw = Math.ceil(w / 4), qh = Math.ceil(h / 4), q = qw * qh;
  const record: Mesh3dKernelPostV1 = { near: plan.camera.near, far: plan.camera.far, color, depth, out };
  if (post.dof) {
    record.dof = { focusDistance: post.dof.focusDistance, aperture: post.dof.aperture };
    record.coc = alloc.scratch("coc", Float32Array, n); record.dofQuarter = alloc.scratch("dof-quarter", Float32Array, q * 7); record.dofCounts = alloc.scratch("dof-counts", Float32Array, q);
    record.dofLevels = [1, 2, 3].map(i => alloc.scratch(`dof-level${i}`, Float32Array, q * 7)); record.dofComposite = alloc.scratch("dof-composite", Float32Array, q * 5); record.dofTemp = alloc.scratch("dof-temp", Float32Array, q * 7);
  }
  if (post.bloom) {
    record.bloom = { threshold: post.bloom.threshold, strength: post.bloom.strength, radius: post.bloom.radius };
    record.bloomData = alloc.scratch("bloom-data", Float32Array, q * 3); record.bloomCounts = alloc.scratch("bloom-counts", Float32Array, q); record.bloomGlow = alloc.scratch("bloom-glow", Float32Array, q * 3);
    record.bloomLayer = alloc.scratch("bloom-layer", Float32Array, q * 3); record.bloomTemp = alloc.scratch("bloom-temp", Float32Array, q * 3);
  }
  if (post.fisheye) record.fisheye = { strength: post.fisheye.strength };
  if (post.vignette) record.vignette = { strength: post.vignette.strength, softness: post.vignette.softness };
  if (post.ao) {
    const mask = job.aoMask = alloc.scratch("ao-mask", Uint8Array, n);
    const half = Math.ceil(w / 2) * Math.ceil(h / 2);
    record.ao = { strength: post.ao.strength, radius: post.ao.radius, tanHalfFov: Math.tan(plan.camera.verticalFovDegrees * Math.PI / 360), aspect: w / h, mask,
      linear: alloc.scratch("ao-linear", Float32Array, n), raw: alloc.scratch("ao-raw", Float32Array, half), tmp: alloc.scratch("ao-tmp", Float32Array, half), half: alloc.scratch("ao-half", Float32Array, half) };
  }
  if (plan.gap) { record.gap = plan.gap; record.gapTemp = alloc.scratch("gap", Float32Array, n * 3); }
  return record;
}
