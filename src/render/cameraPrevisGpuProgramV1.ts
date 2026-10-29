import { Matrix3, Matrix4, Vector3 } from "three";
import { Mesh3dGeometryCache } from "../motion/mesh3dGeometry";
import { mesh3dObjectMatrixAtV1, mesh3dProjection } from "../motion/mesh3dRasterizer";
import type { Mesh3dCamera, Mesh3dScene, Mesh3dSegment } from "../motion/mesh3dScene";
import { mesh3dMaterialExtendedV1, mesh3dSceneExtendedV1 } from "../motion/mesh3dShading";

/** Geometry kinds this program draws as plain lit meshes. Glyph kinds (text, text_extrude, band_text) need the CPU glyph
 * path, so any future kind is refused until it is added here explicitly. */
const PREVIS_GPU_GEOMETRY_KINDS = new Set(["box", "sphere", "curved_video", "torus", "cone", "cylinder", "star", "rounded_box"]);

/**
 * What this program cannot draw as the CPU renderer does, or undefined. It draws per-vertex key + ambient light in the
 * material colour, with at most 32 objects / 60k triangles: everything per-pixel or textured is refused, never drawn flat.
 * Polish fields (2026-10-23) are named explicitly: key-light shadow / size / distance, post (incl. ao), material roughness,
 * texture sampling (alpha, mipmaps), grid style and shadow flags, camera roll, non-default UV modes and torus tube segments.
 * `cameras`: cameras drawn besides the scene's own (previs paths).
 */
export function cameraPrevisGpuRefusalV1(scene: Mesh3dScene, cameras: readonly Mesh3dCamera[] = []): string | undefined {
  if (scene.overlaysV1) return "overlaysV1";
  if (scene.background.grid) return "background.grid";
  if (scene.background.radial) return "background.radial";
  if (scene.post) return `post.${Object.keys(scene.post).join("+")}`;
  for (const key of ["shadow", "size", "distance", "fill", "hemisphere"] as const) if (scene.light[key] !== undefined) return `light.${key}`;
  if (mesh3dSceneExtendedV1(scene)) return "extended scene";
  const rolled = (camera: Mesh3dCamera) => camera.roll !== undefined && camera.roll !== 0;
  for (const segment of scene.segments) {
    if ([segment.camera, ...segment.cameraKeyframes.map(k => k.camera)].some(rolled)) return "camera.roll";
    for (const { geometry, material } of segment.objects) {
      if (!PREVIS_GPU_GEOMETRY_KINDS.has(geometry.kind)) return `geometry.${geometry.kind}`;
      if ((geometry.kind === "box" && geometry.uvMode !== undefined && geometry.uvMode !== "repeat")
        || (geometry.kind === "rounded_box" && geometry.uvMode !== undefined && geometry.uvMode !== "planar")) return "geometry.uvMode";
      if (geometry.kind === "torus" && geometry.tubeSegments !== undefined && geometry.tubeSegments !== 8) return "geometry.tubeSegments";
      if (material.clipId !== undefined) return "material.clipId";
      if (material.grid) return "material.grid";
      for (const key of ["roughness", "texture", "gridStyle", "castShadow", "receiveShadow"] as const) if (material[key] !== undefined) return `material.${key}`;
      if (mesh3dMaterialExtendedV1(material)) return "extended material";
    }
  }
  if (cameras.some(rolled)) return "camera.roll";
  return undefined;
}
/** Throws PREVIS_GPU_UNSUPPORTED_LAYER_REQUIRES_CPU (with the field) before any geometry, context or upload work. */
export function assertCameraPrevisGpuDrawableV1(scene: Mesh3dScene, cameras: readonly Mesh3dCamera[] = []): void {
  const refusal = cameraPrevisGpuRefusalV1(scene, cameras);
  if (refusal !== undefined) throw Error(`PREVIS_GPU_UNSUPPORTED_LAYER_REQUIRES_CPU: ${refusal}`);
}

const owners = new WeakSet<HTMLCanvasElement>();
const vertexSource = `#version 300 es
precision highp float;
layout(location=0) in vec3 position;
layout(location=1) in vec3 normal;
uniform mat4 mvp;
uniform mat3 normalMatrix;
uniform vec3 light;
uniform float ambient;
uniform float intensity;
uniform bool unlit;
out float illumination;
void main(){
 gl_Position=mvp*vec4(position,1.0);
 illumination=unlit?1.0:min(1.15,ambient+intensity*max(0.0,dot(normalize(normalMatrix*normal),light)));
}`;
const fragmentSource = `#version 300 es
precision highp float;
in float illumination;
uniform vec3 pigment;
out vec4 outputColor;
void main(){outputColor=vec4(pigment*illumination,1.0);}`;
const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);

type ResidentMesh = { vao: WebGLVertexArrayObject; buffers: WebGLBuffer[]; count: number; bytes: number };

class PrevisGpuResources {
  private readonly gl: WebGL2RenderingContext;
  private disposed = false;
  private lost = false;
  private uploads = 0;
  private program: WebGLProgram | null = null;
  private color: WebGLTexture | null = null;
  private depth: WebGLRenderbuffer | null = null;
  private target: WebGLFramebuffer | null = null;
  private readonly meshes = new Map<string, ResidentMesh>();
  private readonly fences = new Set<WebGLSync>();
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  readonly identity: { version: string; renderer: string; vendor: string };
  private readonly onLost = (event: Event) => { event.preventDefault(); this.lost = true; };
  constructor(private readonly canvas: HTMLCanvasElement, private readonly width: number, private readonly height: number, private readonly cache: Mesh3dGeometryCache) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 1920 || height > 1080) throw Error("PREVIS_GPU_SIZE_INVALID");
    if (owners.has(canvas)) throw Error("PREVIS_GPU_ALREADY_OWNED");
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: true, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: "high-performance" });
    if (!gl || gl.isContextLost()) throw Error("PREVIS_GPU_UNAVAILABLE");
    this.gl = gl; owners.add(canvas); canvas.addEventListener("webglcontextlost", this.onLost);
    try {
      this.initialize(); canvas.width = width; canvas.height = height;
      this.uniforms = Object.fromEntries(["mvp", "normalMatrix", "light", "ambient", "intensity", "unlit", "pigment"].map(key => [key, gl.getUniformLocation(this.program!, key)]));
      const debug = gl.getExtension("WEBGL_debug_renderer_info");
      this.identity = { version: gl.getParameter(gl.VERSION), renderer: gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER), vendor: gl.getParameter(debug ? debug.UNMASKED_VENDOR_WEBGL : gl.VENDOR) };
    } catch (error) { this.dispose(); throw error; }
  }
  private live() { if (this.disposed || this.lost || this.gl.isContextLost()) throw Error("PREVIS_GPU_DISPOSED_OR_CONTEXT_LOST"); }
  private shader(kind: number, source: string) {
    const gl = this.gl, shader = gl.createShader(kind); if (!shader) throw Error("PREVIS_GPU_ALLOCATION_FAILED");
    gl.shaderSource(shader, source); gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { const log = gl.getShaderInfoLog(shader); gl.deleteShader(shader); throw Error(`PREVIS_GPU_SHADER_FAILED: ${log}`); }
    return shader;
  }
  private initialize() {
    const gl = this.gl, vertex = this.shader(gl.VERTEX_SHADER, vertexSource); let fragment: WebGLShader | undefined;
    try {
      fragment = this.shader(gl.FRAGMENT_SHADER, fragmentSource); this.program = gl.createProgram(); if (!this.program) throw Error("PREVIS_GPU_ALLOCATION_FAILED");
      gl.attachShader(this.program, vertex); gl.attachShader(this.program, fragment); gl.linkProgram(this.program);
      if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw Error(`PREVIS_GPU_LINK_FAILED: ${gl.getProgramInfoLog(this.program)}`);
    } finally { gl.deleteShader(vertex); if (fragment) gl.deleteShader(fragment); }
    this.color = gl.createTexture(); this.depth = gl.createRenderbuffer(); this.target = gl.createFramebuffer();
    if (!this.color || !this.depth || !this.target) throw Error("PREVIS_GPU_ALLOCATION_FAILED");
    gl.bindTexture(gl.TEXTURE_2D, this.color); gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, this.width, this.height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depth); gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, this.width, this.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.color, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depth);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE || gl.getError() !== gl.NO_ERROR) throw Error("PREVIS_GPU_TARGET_FAILED");
  }
  private releaseMesh(mesh: ResidentMesh) { mesh.buffers.forEach(b => this.gl.deleteBuffer(b)); this.gl.deleteVertexArray(mesh.vao); }
  private upload(geometry: Mesh3dSegment["objects"][number]["geometry"]): ResidentMesh {
    const gl = this.gl, mesh = this.cache.get(geometry), vao = gl.createVertexArray(), buffers: WebGLBuffer[] = [];
    if (!vao) throw Error("PREVIS_GPU_ALLOCATION_FAILED"); gl.bindVertexArray(vao);
    try {
      for (const [i, data] of [mesh.positions, mesh.normals, mesh.indices].entries()) {
        const buffer = gl.createBuffer(); if (!buffer) throw Error("PREVIS_GPU_ALLOCATION_FAILED"); buffers.push(buffer);
        const kind = i === 2 ? gl.ELEMENT_ARRAY_BUFFER : gl.ARRAY_BUFFER; gl.bindBuffer(kind, buffer); gl.bufferData(kind, data, gl.STATIC_DRAW);
        if (i < 2) { gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, 3, gl.FLOAT, false, 0, 0); }
      }
      if (gl.getError() !== gl.NO_ERROR) throw Error("PREVIS_GPU_UPLOAD_FAILED"); this.uploads++;
      return { vao, buffers, count: mesh.indices.length, bytes: mesh.positions.byteLength + mesh.normals.byteLength + mesh.indices.byteLength };
    } catch (error) { buffers.forEach(b => gl.deleteBuffer(b)); gl.deleteVertexArray(vao); throw error; }
  }
  draw(scene: Mesh3dScene, segment: Mesh3dSegment, seconds: number, camera: Mesh3dCamera) {
    // The drawn segment and camera, before any geometry is built or uploaded.
    this.live(); assertCameraPrevisGpuDrawableV1({ ...scene, segments: [segment] }, [camera]);
    const gl = this.gl, keys = new Set(segment.objects.map(o => JSON.stringify(o.geometry)));
    const triangles = segment.objects.reduce((n, o) => n + this.cache.get(o.geometry).indices.length / 3, 0);
    if (segment.objects.length > 32 || triangles > 60_000) throw Error("PREVIS_GPU_MESH_BUDGET");
    for (const [key, mesh] of this.meshes) if (!keys.has(key)) { this.releaseMesh(mesh); this.meshes.delete(key); }
    for (const o of segment.objects) { const key = JSON.stringify(o.geometry); if (!this.meshes.has(key)) this.meshes.set(key, this.upload(o.geometry)); }
    const projection = mesh3dProjection(camera, this.width / this.height), direction = new Vector3(...scene.light.direction).normalize(), uniforms = this.uniforms;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target); gl.viewport(0, 0, this.width, this.height); gl.useProgram(this.program);
    gl.disable(gl.BLEND); gl.disable(gl.DITHER); gl.disable(gl.SCISSOR_TEST); gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthMask(true); gl.frontFace(gl.CCW); gl.cullFace(gl.BACK);
    const background = rgb(scene.background.color); gl.clearColor(background[0], background[1], background[2], 1); gl.clearDepth(1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.uniform3f(uniforms.light, direction.x, direction.y, direction.z); gl.uniform1f(uniforms.ambient, scene.light.ambient); gl.uniform1f(uniforms.intensity, scene.light.intensity);
    for (const object of segment.objects) {
      const mesh = this.meshes.get(JSON.stringify(object.geometry))!, model = mesh3dObjectMatrixAtV1(object, seconds), pigment = rgb(object.material.color);
      gl.uniformMatrix4fv(uniforms.mvp, false, new Matrix4().multiplyMatrices(projection, model).elements); gl.uniformMatrix3fv(uniforms.normalMatrix, false, new Matrix3().getNormalMatrix(model).elements);
      gl.uniform3f(uniforms.pigment, pigment[0], pigment[1], pigment[2]); gl.uniform1i(uniforms.unlit, Number(object.material.unlit));
      if (object.material.doubleSided) gl.disable(gl.CULL_FACE); else gl.enable(gl.CULL_FACE);
      gl.bindVertexArray(mesh.vao); gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0);
    }
    gl.bindVertexArray(null); gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.target); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(0, 0, this.width, this.height, 0, 0, this.width, this.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    if (gl.getError() !== gl.NO_ERROR) throw Error("PREVIS_GPU_DRAW_FAILED");
    return { triangles, uploads: this.uploads, residentGeometryBytes: this.stats().residentGeometryBytes };
  }
  /** QA/thumbnails only; interactive draw performs no readback. */
  readPixels() {
    this.live(); const gl = this.gl, raw = new Uint8Array(this.width * this.height * 4), output = new Uint8ClampedArray(raw.length);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target); gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    for (let y = 0; y < this.height; y++) output.set(raw.subarray((this.height - 1 - y) * this.width * 4, (this.height - y) * this.width * 4), y * this.width * 4);
    return output;
  }
  async waitForCompletion(signal?: AbortSignal, timeoutMs = 500) {
    this.live(); if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw Error("PREVIS_GPU_WAIT_BUDGET");
    if (signal?.aborted) throw signal.reason ?? Error("PREVIS_GPU_WAIT_ABORTED");
    const gl = this.gl, fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); if (!fence) throw Error("PREVIS_GPU_FENCE_FAILED");
    this.fences.add(fence); gl.flush(); const deadline = performance.now() + timeoutMs;
    try {
      for (;;) {
        this.live(); if (signal?.aborted) throw signal.reason ?? Error("PREVIS_GPU_WAIT_ABORTED");
        const status = gl.clientWaitSync(fence, 0, 0);
        if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) return;
        if (status === gl.WAIT_FAILED || performance.now() > deadline) throw Error("PREVIS_GPU_WAIT_FAILED_OR_TIMEOUT");
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    } finally { if (this.fences.delete(fence) && !this.lost && !gl.isContextLost()) gl.deleteSync(fence); }
  }
  dispose() {
    if (this.disposed) return; this.disposed = true;
    // Context loss already destroyed its objects. Never delete stale handles
    // against a restored context generation, even if isContextLost() is now false.
    if (!this.lost && !this.gl.isContextLost()) {
      this.meshes.forEach(m => this.releaseMesh(m)); this.fences.forEach(f => this.gl.deleteSync(f));
      this.gl.deleteFramebuffer(this.target); this.gl.deleteTexture(this.color); this.gl.deleteRenderbuffer(this.depth); this.gl.deleteProgram(this.program);
    }
    this.meshes.clear(); this.fences.clear(); this.target = this.color = this.depth = this.program = null;
    this.canvas.removeEventListener("webglcontextlost", this.onLost); owners.delete(this.canvas);
  }
  stats() { return { disposed: this.disposed, contextLost: this.lost || this.gl.isContextLost(), uploads: this.uploads, activeGeometries: this.meshes.size, pendingFences: this.fences.size,
    residentGeometryBytes: [...this.meshes.values()].reduce((n, m) => n + m.bytes, 0), attachmentLogicalBytes: this.disposed ? 0 : this.width * this.height * 8 }; }
}
/** One resource owner per canvas; all camera semantics stay in the shared adapter. */
export function createCameraPrevisGpuProgramV1(canvas: HTMLCanvasElement, width: number, height: number, cache: Mesh3dGeometryCache) {
  const owner = new PrevisGpuResources(canvas, width, height, cache);
  return { draw: owner.draw.bind(owner), readPixels: owner.readPixels.bind(owner), waitForCompletion: owner.waitForCompletion.bind(owner),
    dispose: owner.dispose.bind(owner), identity: owner.identity, stats: owner.stats.bind(owner) };
}
