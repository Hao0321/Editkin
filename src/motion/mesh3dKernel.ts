/**
 * mesh3d pixel kernel (polish 2026-10-23).
 *
 * Every per-pixel loop of the CPU mesh renderer lives here: background, the original
 * per-vertex triangle path, the per-pixel shading path, shadow maps, ambient
 * occlusion and the post chain. One frame is a list of phases over row bands, quarter
 * rows or columns; `ctx` hands out work items and separates phases with a barrier.
 * Serially (one rank, no-op barrier) the items run in order. In worker threads
 * (mesh3dParallel.ts) any rank may take any item: every pixel is written by exactly
 * one item with the same arithmetic in the same order, so the bytes do not depend on
 * the number of threads.
 *
 * SELF-CONTAINED: the factory's source text is evaluated inside worker threads, so it
 * must not reference imports or module-level bindings (types only; they are erased).
 */

export interface Mesh3dKernelCtxV1 {
  /** Work counters (one per phase) and nothing else; Atomics work on shared and plain arrays. */
  ctl: Int32Array; phaseBase: number; maxPhases: number; phase: number;
  sync(): void;
}
export interface Mesh3dKernelTextureV1 {
  width: number; height: number; rgba: Uint8Array | Uint8ClampedArray;
  /** 0: original per-pixel bilinear (edge-centred), 1: nearest, 2: bilinear, 3: trilinear mipmaps. */
  filter: number; alpha: boolean;
  /** Premultiplied RGBA float levels 1..n (level 0 is `rgba`), filled by the kernel's mip phase. */
  mips: Float32Array[]; mipWidth: number[]; mipHeight: number[];
}
export interface Mesh3dKernelMaskLevelV1 { width: number; height: number; alpha: Uint8Array; }
export interface Mesh3dKernelMaterialV1 {
  unlit: boolean; doubleSided: boolean;
  baseR: number; baseG: number; baseB: number; gridR: number; gridG: number; gridB: number;
  hasStripes: boolean; sAr: number; sAg: number; sAb: number; sBr: number; sBg: number; sBb: number; stripeCos: number; stripeSin: number;
  hasGradient: boolean; gAr: number; gAg: number; gAb: number; gBr: number; gBg: number; gBb: number;
  hasGrid: boolean;
  hasWire: boolean; wireFill: boolean; wireR: number; wireG: number; wireB: number; wireHalf: number; divU: number; divV: number;
  hasEmissive: boolean; emR: number; emG: number; emB: number;
  hasRim: boolean; rimR: number; rimG: number; rimB: number; rimPower: number;
  specStrength: number; shininess: number;
  hasReflection: boolean; reflK: number; skyR: number; skyG: number; skyB: number; horR: number; horG: number; horB: number; grR: number; grG: number; grB: number;
  /** Polish fields; neutral values when the material does not use them. */
  hasGgx: boolean; ggxAlpha: number; ggxA2: number; ggxNorm: number; roughness: number;
  hasGridStyle: boolean; gridCellsU: number; gridCellsV: number; gridHalf: number; gsR: number; gsG: number; gsB: number; gridFadeStart: number; gridFadeEnd: number;
  receiveShadow: boolean; aoWeight: number;
}
export interface Mesh3dKernelDrawV1 {
  /** 0: original per-vertex path (7 values per vertex), 1: per-pixel path (13 values per vertex). */
  kind: number; id: number; vertices: Float64Array; indices: Uint32Array; doubleSided: boolean;
  /** Conservative screen rows touched (bands outside skip the draw). */
  yMin: number; yMax: number;
  color: number[]; grid: boolean; texture?: Mesh3dKernelTextureV1;
  mat?: Mesh3dKernelMaterialV1; mask?: { levels: Mesh3dKernelMaskLevelV1[]; repeat: number };
  cast: boolean; shadowXYZ?: Float64Array; shadowYMin: number; shadowYMax: number; alphaCast: boolean;
}
export interface Mesh3dKernelShadowLevelV1 { width: number; height: number; depth: Float32Array; id: Uint16Array; }
export interface Mesh3dKernelShadowV1 {
  rx: number; ry: number; rz: number; ux: number; uy: number; uz: number; fx: number; fy: number; fz: number;
  x0: number; y0: number; invTexel: number; zMin: number;
  softness: number; strength: number; bias: number; normalOffset: number; maxRadius: number;
  levels: Mesh3dKernelShadowLevelV1[];
}
export interface Mesh3dKernelLightV1 {
  lx: number; ly: number; lz: number; keyI: number; ambient: number;
  hasFill: boolean; fx: number; fy: number; fz: number; fillR: number; fillG: number; fillB: number; fillI: number;
  hasHemi: boolean; hemiI: number; hgR: number; hgG: number; hgB: number; hdR: number; hdG: number; hdB: number;
  camX: number; camY: number; camZ: number;
  /** Area light (polish): diffuse wrap, 0 when the scene has no `light.size`. */
  wrap: number;
  /** Positional key (polish `light.distance`): sphere light at (ptX, ptY, ptZ), radius ptR; attenuation falloffRef / (d² + ptR²). */
  hasPoint: boolean; ptX: number; ptY: number; ptZ: number; ptR: number; falloffRef: number;
}
export interface Mesh3dKernelPassV1 { draws: Mesh3dKernelDrawV1[]; light: Mesh3dKernelLightV1; shadow?: Mesh3dKernelShadowV1; }
export interface Mesh3dKernelBackgroundV1 {
  color: number[]; gridColor: number[]; spacing: number; grid: boolean; extended: boolean;
  radial?: { color: number[]; center: number[]; radius: number; strength: number };
}
export interface Mesh3dKernelPostV1 {
  near: number; far: number; color: Float32Array; depth: Float32Array;
  dof?: { focusDistance: number; aperture: number }; bloom?: { threshold: number; strength: number; radius: number };
  fisheye?: { strength: number }; vignette?: { strength: number; softness: number };
  /** AO buffers: linear depth (full res); raw, tmp and half (half-res AO, blur scratch, half-res linear depth). */
  ao?: { strength: number; radius: number; tanHalfFov: number; aspect: number; mask: Uint8Array; linear: Float32Array; raw: Float32Array; tmp: Float32Array; half: Float32Array };
  gap?: { sx: number; sy: number };
  /** Scratch, sized by the planner (only the buffers the enabled effects need). */
  coc?: Float32Array; dofQuarter?: Float32Array; dofCounts?: Float32Array; dofLevels?: Float32Array[]; dofComposite?: Float32Array; dofTemp?: Float32Array;
  bloomData?: Float32Array; bloomCounts?: Float32Array; bloomGlow?: Float32Array; bloomLayer?: Float32Array; bloomTemp?: Float32Array;
  gapTemp?: Float32Array;
  out: Uint8ClampedArray;
}
export interface Mesh3dKernelJobV1 {
  width: number; height: number;
  /** Raster passes (motion-blur sub-frames); `centre` supplies the returned depth and counts. */
  passes: Mesh3dKernelPassV1[]; centre: number;
  background: Mesh3dKernelBackgroundV1;
  rgba: Uint8ClampedArray; writeRgba: boolean; depth: Float32Array; depthPrecise?: Float64Array; hdr?: Float32Array;
  /** Multi-pass only: per-pass depth is copied here from the centre pass; HDR is averaged into `sum`. */
  refDepth?: Float32Array; refPrecise?: Float64Array; sum?: Float32Array;
  aoMask?: Uint8Array;
  textures: Mesh3dKernelTextureV1[];
  post?: Mesh3dKernelPostV1;
}

export function mesh3dKernelFactoryV1() {
  const STRIDE = 13, QUARTER = 4, ROWS = 16, QROWS = 8, COLS = 32;
  const LITTLE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
  const EMPTY_ID = 65535;

  // ---------------------------------------------------------------- scheduling
  function each(ctx: Mesh3dKernelCtxV1, total: number, chunk: number, fn: (a: number, b: number) => void): void {
    const phase = ctx.phase++;
    if (phase >= ctx.maxPhases) throw new Error("MESH_KERNEL_PHASE_BUDGET");
    const slot = ctx.phaseBase + phase, n = Math.ceil(total / chunk);
    for (;;) {
      const i = Atomics.add(ctx.ctl, slot, 1);
      if (i >= n) return;
      const a = i * chunk; fn(a, Math.min(total, a + chunk));
    }
  }
  function serialCtx(): Mesh3dKernelCtxV1 { return { ctl: new Int32Array(1024), phaseBase: 0, maxPhases: 1024, phase: 0, sync() { /* one rank */ } }; }

  // ---------------------------------------------------------------- background
  function paintRows(job: Mesh3dKernelJobV1, y0: number, y1: number): void {
    const { width, rgba } = job, bg = job.background;
    const background = bg.color, grid = bg.gridColor, spacing = bg.spacing * width / 540, stroke = Math.max(.6, width / 1080);
    const pack = (c: number[]) => (c[0] | c[1] << 8 | c[2] << 16 | 255 << 24) >>> 0, words = LITTLE ? new Uint32Array(rgba.buffer, rgba.byteOffset, width * job.height) : undefined;
    const columnOnGrid = new Uint8Array(width);
    if (bg.grid) for (let x = 0; x < width; x++) columnOnGrid[x] = Number(Math.abs((x + spacing * .5) % spacing - spacing * .5) <= stroke);
    for (let y = y0; y < y1; y++) {
      const rowOnGrid = bg.grid && Math.abs((y + spacing * .5) % spacing - spacing * .5) <= stroke;
      if (words && (rowOnGrid || !bg.grid)) { words.fill(pack(rowOnGrid ? grid : background), y * width, (y + 1) * width); continue; }
      for (let x = 0; x < width; x++) {
        const c = rowOnGrid || columnOnGrid[x] ? grid : background, p = (y * width + x) * 4;
        rgba[p] = c[0]; rgba[p + 1] = c[1]; rgba[p + 2] = c[2]; rgba[p + 3] = 255;
      }
    }
    job.depth.fill(Infinity, y0 * width, y1 * width);
    job.depthPrecise?.fill(Infinity, y0 * width, y1 * width);
    job.aoMask?.fill(0, y0 * width, y1 * width);
    if (bg.extended) paintExtendedRows(job, y0, y1);
  }
  /** Background glow and HDR initialisation from the 8-bit fill (original paintExtendedBackground, by rows). */
  function paintExtendedRows(job: Mesh3dKernelJobV1, y0: number, y1: number): void {
    const { width, height, rgba, hdr } = job, radial = job.background.radial, writeRgba = job.writeRgba;
    if (!radial && !hdr) return;
    const [glowR, glowG, glowB] = radial ? radial.color : [0, 0, 0], inv = 1 / 255;
    const gx = new Float64Array(width), r2 = radial ? radial.radius * radial.radius : 1;
    if (radial) for (let x = 0; x < width; x++) { const d = (x + .5 - radial.center[0] * width) / height; gx[x] = Math.exp(-d * d / r2); }
    for (let y = y0; y < y1; y++) {
      let ky = 0;
      if (radial) { const d = (y + .5 - radial.center[1] * height) / height; ky = radial.strength * Math.exp(-d * d / r2); }
      for (let x = 0; x < width; x++) {
        const p = (y * width + x) * 4, k = ky * gx[x], r0 = rgba[p], g0 = rgba[p + 1], b0 = rgba[p + 2];
        const r = r0 + (glowR - r0) * k, g = g0 + (glowG - g0) * k, b = b0 + (glowB - b0) * k;
        if (writeRgba && radial) { rgba[p] = r; rgba[p + 1] = g; rgba[p + 2] = b; }
        if (hdr) { const q = (y * width + x) * 3; hdr[q] = r * inv; hdr[q + 1] = g * inv; hdr[q + 2] = b * inv; }
      }
    }
  }

  // ---------------------------------------------------------------- original per-vertex path
  const clipDistanceArray = (v: number[], side: number) => side === 0 ? v[0] + v[3] : side === 1 ? v[3] - v[0] : side === 2 ? v[1] + v[3] : side === 3 ? v[3] - v[1] : side === 4 ? v[2] + v[3] : v[3] - v[2];
  const clipDistance = (v: ArrayLike<number>, o: number, side: number) => side === 0 ? v[o] + v[o + 3] : side === 1 ? v[o + 3] - v[o] : side === 2 ? v[o + 1] + v[o + 3] : side === 3 ? v[o + 3] - v[o + 1] : side === 4 ? v[o + 2] + v[o + 3] : v[o + 3] - v[o + 2];
  /** Clip in homogeneous space before division, preserving every attribute. */
  function clipTriangle(input: number[][]): number[][] {
    let polygon = input;
    for (let side = 0; side < 6; side++) {
      if (!polygon.length) break;
      const next: number[][] = [];
      let a = polygon[polygon.length - 1], da = clipDistanceArray(a, side);
      for (const b of polygon) {
        const db = clipDistanceArray(b, side);
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
  const edge = (ax: number, ay: number, bx: number, by: number, x: number, y: number) => (x - ax) * (by - ay) - (y - ay) * (bx - ax);
  function drawLegacy(job: Mesh3dKernelJobV1, d: Mesh3dKernelDrawV1, y0: number, y1: number): number {
    const { width, height, rgba, depth } = job, depthPrecise = job.depthPrecise, depthTest = depthPrecise ?? depth;
    const V = d.vertices, I = d.indices, color = d.color, grid = job.background.gridColor, texture = d.texture, doubleSided = d.doubleSided, gridOn = d.grid;
    const A = [0, 0, 0, 0, 0, 0, 0], B = [0, 0, 0, 0, 0, 0, 0], C = [0, 0, 0, 0, 0, 0, 0];
    let counted = 0;
    for (let index = 0; index < I.length; index += 3) {
      const ia = I[index] * 7, ib = I[index + 1] * 7, ic = I[index + 2] * 7;
      let outside = false, rejected = false;
      for (let side = 0; side < 6; side++) {
        const negatives = Number(clipDistance(V, ia, side) < 0) + Number(clipDistance(V, ib, side) < 0) + Number(clipDistance(V, ic, side) < 0);
        if (negatives === 3) { rejected = true; break; } if (negatives) outside = true;
      }
      if (rejected) continue;
      let polygon: number[][];
      if (outside) {
        polygon = clipTriangle([Array.from(V.subarray(ia, ia + 7)), Array.from(V.subarray(ib, ib + 7)), Array.from(V.subarray(ic, ic + 7))]);
      } else {
        for (let j = 0; j < 7; j++) { A[j] = V[ia + j]; B[j] = V[ib + j]; C[j] = V[ic + j]; }
        polygon = [A, B, C];
      }
      for (let k = 1; k < polygon.length - 1; k++) {
        const a = polygon[0], b = polygon[k], c = polygon[k + 1];
        const qa = 1/a[3], qb = 1/b[3], qc = 1/c[3];
        const ax = (a[0]*qa*.5+.5)*width, ay = (.5-a[1]*qa*.5)*height, bx = (b[0]*qb*.5+.5)*width, by = (.5-b[1]*qb*.5)*height, cx = (c[0]*qc*.5+.5)*width, cy = (.5-c[1]*qc*.5)*height;
        const area = edge(ax, ay, bx, by, cx, cy);
        if (Math.abs(area) < 1e-8 || (!doubleSided && area <= 0)) continue;
        const minX = Math.max(0, Math.ceil(Math.min(ax, bx, cx)-.5)), maxX = Math.min(width-1, Math.floor(Math.max(ax, bx, cx)-.5));
        const minY = Math.max(0, Math.ceil(Math.min(ay, by, cy)-.5)), maxY = Math.min(height-1, Math.floor(Math.max(ay, by, cy)-.5));
        if (minX > maxX || minY > maxY) continue;
        if (minY >= y0 && minY < y1) counted++;
        const za = a[2]*qa, zb = b[2]*qb, zc = c[2]*qc;
        const yEnd = Math.min(maxY, y1 - 1);
        for (let y = Math.max(minY, y0); y <= yEnd; y++) for (let x = minX; x <= maxX; x++) {
          const wa = edge(bx, by, cx, cy, x+.5, y+.5)/area, wb = edge(cx, cy, ax, ay, x+.5, y+.5)/area, wc = 1-wa-wb;
          if (wa < -1e-9 || wb < -1e-9 || wc < -1e-9) continue;
          const dd = wa*za+wb*zb+wc*zc, pixel = y*width+x;
          if (dd >= depthTest[pixel]) continue;
          const reciprocal = wa*qa+wb*qb+wc*qc, u = (wa*a[4]*qa+wb*b[4]*qb+wc*c[4]*qc)/reciprocal, v = (wa*a[5]*qa+wb*b[5]*qb+wc*c[5]*qc)/reciprocal;
          const intensity = (wa*a[6]*qa+wb*b[6]*qb+wc*c[6]*qc)/reciprocal;
          const p = pixel*4;
          if (texture) {
            const tx = Math.max(0, Math.min(texture.width-1, Math.round(u*(texture.width-1)))), ty = Math.max(0, Math.min(texture.height-1, Math.round((1-v)*(texture.height-1)))), tp = (ty*texture.width+tx)*4;
            rgba[p] = texture.rgba[tp]*intensity; rgba[p+1] = texture.rgba[tp+1]*intensity; rgba[p+2] = texture.rgba[tp+2]*intensity;
          } else {
            const line = gridOn && (Math.abs((u*12)%1-.5)>.475 || Math.abs((v*12)%1-.5)>.475), pigment = line ? grid : color;
            rgba[p] = pigment[0]*intensity; rgba[p+1] = pigment[1]*intensity; rgba[p+2] = pigment[2]*intensity;
          }
          depth[pixel] = dd;
          if (depthPrecise) depthPrecise[pixel] = dd;
        }
      }
    }
    return counted;
  }

  // ---------------------------------------------------------------- textures
  /** Premultiplied 2×2 box mip level `k` (rows y0..y1) from level k − 1. */
  function mipRows(t: Mesh3dKernelTextureV1, k: number, y0: number, y1: number): void {
    const w = t.mipWidth[k], pw = t.mipWidth[k - 1], ph = t.mipHeight[k - 1], out = t.mips[k];
    for (let y = y0; y < y1; y++) {
      const ya = Math.min(ph - 1, y * 2), yb = Math.min(ph - 1, y * 2 + 1);
      for (let x = 0; x < w; x++) {
        const xa = Math.min(pw - 1, x * 2), xb = Math.min(pw - 1, x * 2 + 1), o = (y * w + x) * 4;
        if (k === 1) {
          const s = t.rgba, alpha = t.alpha;
          let r = 0, g = 0, b = 0, a = 0;
          for (let corner = 0; corner < 4; corner++) {
            const q = ((corner & 2 ? yb : ya) * pw + (corner & 1 ? xb : xa)) * 4, av = alpha ? s[q + 3] / 255 : 1;
            r += s[q] / 255 * av; g += s[q + 1] / 255 * av; b += s[q + 2] / 255 * av; a += av;
          }
          out[o] = r * .25; out[o + 1] = g * .25; out[o + 2] = b * .25; out[o + 3] = a * .25;
        } else {
          const s = t.mips[k - 1];
          const q0 = (ya * pw + xa) * 4, q1 = (ya * pw + xb) * 4, q2 = (yb * pw + xa) * 4, q3 = (yb * pw + xb) * 4;
          for (let c = 0; c < 4; c++) out[o + c] = (s[q0 + c] + s[q1 + c] + s[q2 + c] + s[q3 + c]) * .25;
        }
      }
    }
  }
  /** Premultiplied bilinear sample of level `k` at texel-space (tx, ty) (centres at i + .5), clamp to edge. */
  function bilinear(t: Mesh3dKernelTextureV1, k: number, tx: number, ty: number, out: Float64Array): void {
    const w = k ? t.mipWidth[k] : t.width, h = k ? t.mipHeight[k] : t.height;
    const fx0 = tx - .5, fy0 = ty - .5, x0 = Math.floor(fx0), y0 = Math.floor(fy0), fx = fx0 - x0, fy = fy0 - y0;
    const xa = x0 < 0 ? 0 : x0 >= w ? w - 1 : x0, xb = x0 + 1 < 0 ? 0 : x0 + 1 >= w ? w - 1 : x0 + 1;
    const ya = y0 < 0 ? 0 : y0 >= h ? h - 1 : y0, yb = y0 + 1 < 0 ? 0 : y0 + 1 >= h ? h - 1 : y0 + 1;
    const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
    const p00 = (ya * w + xa) * 4, p10 = (ya * w + xb) * 4, p01 = (yb * w + xa) * 4, p11 = (yb * w + xb) * 4;
    if (k === 0) {
      const s = t.rgba, alpha = t.alpha;
      const a00 = alpha ? s[p00 + 3] / 255 : 1, a10 = alpha ? s[p10 + 3] / 255 : 1, a01 = alpha ? s[p01 + 3] / 255 : 1, a11 = alpha ? s[p11 + 3] / 255 : 1;
      const k00 = w00 * a00, k10 = w10 * a10, k01 = w01 * a01, k11 = w11 * a11;
      out[0] = (s[p00] * k00 + s[p10] * k10 + s[p01] * k01 + s[p11] * k11) / 255;
      out[1] = (s[p00 + 1] * k00 + s[p10 + 1] * k10 + s[p01 + 1] * k01 + s[p11 + 1] * k11) / 255;
      out[2] = (s[p00 + 2] * k00 + s[p10 + 2] * k10 + s[p01 + 2] * k01 + s[p11 + 2] * k11) / 255;
      out[3] = k00 + k10 + k01 + k11;
    } else {
      const s = t.mips[k];
      for (let c = 0; c < 4; c++) out[c] = s[p00 + c] * w00 + s[p10 + c] * w10 + s[p01 + c] * w01 + s[p11 + c] * w11;
    }
  }
  const sampleA = new Float64Array(4), sampleB = new Float64Array(4);
  /** Straight RGB + alpha of a texture with filter 1–3 into `out`. */
  function sampleTexture(t: Mesh3dKernelTextureV1, u: number, v: number, dudx: number, dudy: number, dvdx: number, dvdy: number, out: Float64Array): void {
    if (t.filter === 1) {
      const x = Math.min(t.width - 1, Math.max(0, Math.floor(u * t.width))), y = Math.min(t.height - 1, Math.max(0, Math.floor((1 - v) * t.height))), p = (y * t.width + x) * 4;
      out[0] = t.rgba[p] / 255; out[1] = t.rgba[p + 1] / 255; out[2] = t.rgba[p + 2] / 255; out[3] = t.alpha ? t.rgba[p + 3] / 255 : 1;
      return;
    }
    const tx = u * t.width, ty = (1 - v) * t.height;
    let level = 0, fraction = 0;
    if (t.filter === 3 && t.mips.length > 1) {
      const ax = dudx * t.width, ay = dvdx * t.height, bx = dudy * t.width, by = dvdy * t.height;
      const rho2 = Math.max(ax * ax + ay * ay, bx * bx + by * by);
      if (rho2 > 1) {
        const lambda = Math.min(t.mips.length - 1, .5 * Math.log2(rho2));
        level = Math.floor(lambda); fraction = lambda - level;
        if (level >= t.mips.length - 1) { level = t.mips.length - 1; fraction = 0; }
      }
    }
    const scaleA = level ? 1 / (1 << level) : 1;
    bilinear(t, level, tx * scaleA, ty * scaleA, sampleA);
    if (fraction > 0) {
      const scaleB = 1 / (1 << (level + 1));
      bilinear(t, level + 1, tx * scaleB, ty * scaleB, sampleB);
      for (let c = 0; c < 4; c++) sampleA[c] += (sampleB[c] - sampleA[c]) * fraction;
    }
    const a = sampleA[3];
    if (a > 1e-6) { out[0] = sampleA[0] / a; out[1] = sampleA[1] / a; out[2] = sampleA[2] / a; } else { out[0] = 0; out[1] = 0; out[2] = 0; }
    out[3] = t.alpha ? (a > 1 ? 1 : a) : 1;
  }

  // ---------------------------------------------------------------- band text masks
  function sampleLevel(level: Mesh3dKernelMaskLevelV1, u: number, v: number): number {
    const x = u * level.width - .5, y = (1 - v) * level.height - .5, x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, w = level.width;
    const xa = ((x0 % w) + w) % w, xb = (xa + 1) % w, ya = Math.max(0, Math.min(level.height - 1, y0)), yb = Math.max(0, Math.min(level.height - 1, y0 + 1));
    const a = level.alpha;
    return ((a[ya * w + xa] * (1 - fx) + a[ya * w + xb] * fx) * (1 - fy) + (a[yb * w + xa] * (1 - fx) + a[yb * w + xb] * fx) * fy) / 255;
  }
  /** Integral of a period-2 square wave (0 on [0,1), 1 on [1,2)): box-filtered stripes. */
  function squareIntegral(x: number): number { const f = Math.floor(x / 2), r = x - 2 * f; return f + Math.max(0, r - 1); }

  // ---------------------------------------------------------------- shadows
  /** Vogel spirals: fixed, evenly spread taps (no per-pixel noise, so moving frames do not crawl). */
  const spiral = (n: number) => { const out = new Float64Array(n * 2); for (let i = 0; i < n; i++) { const r = Math.sqrt((i + .5) / n), a = i * 2.399963229728653; out[i * 2] = Math.cos(a) * r; out[i * 2 + 1] = Math.sin(a) * r; } return out; };
  const SEARCH = spiral(12), PCF = spiral(12);
  function shadowRows(sh: Mesh3dKernelShadowV1, d: Mesh3dKernelDrawV1, y0: number, y1: number): void {
    const L = sh.levels[0], w = L.width, depth = L.depth, ids = L.id, P = d.shadowXYZ!, I = d.indices, id = d.id;
    const alphaCast = d.alphaCast && d.texture ? d.texture : undefined, V = d.vertices;
    for (let index = 0; index < I.length; index += 3) {
      const a = I[index], b = I[index + 1], c = I[index + 2];
      const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2], bx = P[b * 3], by = P[b * 3 + 1], bz = P[b * 3 + 2], cx = P[c * 3], cy = P[c * 3 + 1], cz = P[c * 3 + 2];
      const minY = Math.max(y0, Math.ceil(Math.min(ay, by, cy) - .5)), maxY = Math.min(y1 - 1, Math.floor(Math.max(ay, by, cy) - .5));
      if (minY > maxY) continue;
      const minX = Math.max(0, Math.ceil(Math.min(ax, bx, cx) - .5)), maxX = Math.min(w - 1, Math.floor(Math.max(ax, bx, cx) - .5));
      if (minX > maxX) continue;
      const area = (cx - ax) * (by - ay) - (cy - ay) * (bx - ax);
      if (Math.abs(area) < 1e-12) continue;
      const inv = 1 / area;
      const ua = alphaCast ? V[a * STRIDE + 4] : 0, ub = alphaCast ? V[b * STRIDE + 4] : 0, uc = alphaCast ? V[c * STRIDE + 4] : 0;
      const va = alphaCast ? V[a * STRIDE + 5] : 0, vb = alphaCast ? V[b * STRIDE + 5] : 0, vc = alphaCast ? V[c * STRIDE + 5] : 0;
      for (let y = minY; y <= maxY; y++) {
        const py = y + .5;
        for (let x = minX; x <= maxX; x++) {
          const px = x + .5;
          const wa = ((px - bx) * (cy - by) - (py - by) * (cx - bx)) * inv, wb = ((px - cx) * (ay - cy) - (py - cy) * (ax - cx)) * inv, wc = 1 - wa - wb;
          if (wa < -1e-7 || wb < -1e-7 || wc < -1e-7) continue;
          const z = wa * az + wb * bz + wc * cz, t = y * w + x;
          if (!(z < depth[t])) continue;
          if (alphaCast) {
            const u = wa * ua + wb * ub + wc * uc, v = wa * va + wb * vb + wc * vc;
            // Untextured faces (NaN UVs) of an alpha-textured draw have no coverage: the card is its textured face.
            if (u !== u) continue;
            const tx = Math.min(alphaCast.width - 1, Math.max(0, Math.floor(u * alphaCast.width))), ty = Math.min(alphaCast.height - 1, Math.max(0, Math.floor((1 - v) * alphaCast.height)));
            if (alphaCast.rgba[(ty * alphaCast.width + tx) * 4 + 3] < 128) continue;
          }
          depth[t] = z; ids[t] = id;
        }
      }
    }
  }
  function shadowDownRows(sh: Mesh3dKernelShadowV1, k: number, y0: number, y1: number): void {
    const P = sh.levels[k - 1], L = sh.levels[k], pw = P.width, ph = P.height, w = L.width;
    for (let y = y0; y < y1; y++) {
      const ya = Math.min(ph - 1, y * 2), yb = Math.min(ph - 1, y * 2 + 1);
      for (let x = 0; x < w; x++) {
        const xa = Math.min(pw - 1, x * 2), xb = Math.min(pw - 1, x * 2 + 1);
        let best = ya * pw + xa, q = ya * pw + xb;
        if (P.depth[q] < P.depth[best]) best = q;
        q = yb * pw + xa; if (P.depth[q] < P.depth[best]) best = q;
        q = yb * pw + xb; if (P.depth[q] < P.depth[best]) best = q;
        L.depth[y * w + x] = P.depth[best]; L.id[y * w + x] = P.id[best];
      }
    }
  }
  function shadowPhases(ctx: Mesh3dKernelCtxV1, pass: Mesh3dKernelPassV1): void {
    const sh = pass.shadow!, L0 = sh.levels[0];
    each(ctx, L0.height, ROWS * 2, (y0, y1) => {
      L0.depth.fill(Infinity, y0 * L0.width, y1 * L0.width); L0.id.fill(EMPTY_ID, y0 * L0.width, y1 * L0.width);
      for (const d of pass.draws) if (d.cast && d.shadowYMax >= y0 && d.shadowYMin < y1) shadowRows(sh, d, y0, y1);
    });
    ctx.sync();
    for (let k = 1; k < sh.levels.length; k++) { each(ctx, sh.levels[k].height, ROWS, (y0, y1) => shadowDownRows(sh, k, y0, y1)); ctx.sync(); }
  }
  /** Bilinear percentage-closer filter on min-depth level `k` with 12 spiral taps of radius `radius` (level-0 texels). */
  function pcf(sh: Mesh3dKernelShadowV1, k: number, sx: number, sy: number, radius: number, z: number, self: number): number {
    const L = sh.levels[k], w = L.width, h = L.height, depth = L.depth, ids = L.id, scale = 1 / (1 << k), limit = z - sh.bias * (1 << k);
    let lit = 0;
    for (let i = 0; i < 12; i++) {
      const tx = (sx + PCF[i * 2] * radius) * scale - .5, ty = (sy + PCF[i * 2 + 1] * radius) * scale - .5;
      const x0 = Math.floor(tx), y0 = Math.floor(ty), fx = tx - x0, fy = ty - y0;
      let s00 = 1, s10 = 1, s01 = 1, s11 = 1;
      if (y0 >= 0 && y0 < h) {
        const row = y0 * w;
        if (x0 >= 0 && x0 < w && depth[row + x0] < limit && ids[row + x0] !== self) s00 = 0;
        if (x0 + 1 >= 0 && x0 + 1 < w && depth[row + x0 + 1] < limit && ids[row + x0 + 1] !== self) s10 = 0;
      }
      if (y0 + 1 >= 0 && y0 + 1 < h) {
        const row = (y0 + 1) * w;
        if (x0 >= 0 && x0 < w && depth[row + x0] < limit && ids[row + x0] !== self) s01 = 0;
        if (x0 + 1 >= 0 && x0 + 1 < w && depth[row + x0 + 1] < limit && ids[row + x0 + 1] !== self) s11 = 0;
      }
      lit += (s00 * (1 - fx) + s10 * fx) * (1 - fy) + (s01 * (1 - fx) + s11 * fx) * fy;
    }
    return lit / 12;
  }
  /**
   * Fraction of the key light reaching a world point (1 = lit). Percentage-closer soft
   * shadows: a blocker search estimates the occluder distance, the penumbra grows with
   * it (contact hardening), and wide penumbras filter a coarser min-depth level so the
   * tap count stays fixed. The receiver's own object is skipped (no self-shadow acne).
   */
  function shadowLit(sh: Mesh3dKernelShadowV1, wx: number, wy: number, wz: number, nx: number, ny: number, nz: number, self: number): number {
    const off = sh.normalOffset, px = wx + nx * off, py = wy + ny * off, pz = wz + nz * off;
    const sx = (px * sh.rx + py * sh.ry + pz * sh.rz - sh.x0) * sh.invTexel, sy = (px * sh.ux + py * sh.uy + pz * sh.uz - sh.y0) * sh.invTexel;
    const z = px * sh.fx + py * sh.fy + pz * sh.fz, L0 = sh.levels[0], top = sh.levels.length - 1;
    if (!(sx > -4 && sy > -4 && sx < L0.width + 4 && sy < L0.height + 4) || z <= sh.zMin) return 1;
    let search = sh.softness * (z - sh.zMin) * sh.invTexel;
    search = search < 1.5 ? 1.5 : search > sh.maxRadius ? sh.maxRadius : search;
    // Hierarchical search window: the min-depth level whose texels are at least the window's size covers it with
    // ≤ 2×2 texels. Nothing nearer than the receiver there → no blocker. Otherwise the nearest depth found bounds
    // how far any blocker in the window can cast a penumbra, so the window shrinks to that reach (≤ 3 rounds).
    for (let round = 0; round < 3; round++) {
      let lc = 0; while (lc < top && (1 << lc) < search * 2) lc++;
      const C = sh.levels[lc], cw = C.width, ch = C.height, inv = 1 / (1 << lc), limit = z - sh.bias;
      const xa = Math.max(0, Math.floor((sx - search) * inv)), xb = Math.min(cw - 1, Math.floor((sx + search) * inv));
      const ya = Math.max(0, Math.floor((sy - search) * inv)), yb = Math.min(ch - 1, Math.floor((sy + search) * inv));
      let nearest = Infinity;
      for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) { const d = C.depth[y * cw + x]; if (d < nearest) nearest = d; }
      if (!(nearest < limit)) return 1;
      let reach = sh.softness * (z - nearest) * sh.invTexel; reach = reach < 1.5 ? 1.5 : reach;
      if (reach > search * .7) break;
      search = reach;
    }
    let ls = 0; while (ls < top && search / (1 << ls) > 3) ls++;
    const L = sh.levels[ls], w = L.width, h = L.height, scale = 1 / (1 << ls), limit = z - sh.bias * (1 << ls);
    let sum = 0, count = 0;
    for (let i = 0; i < 12; i++) {
      const x = Math.floor((sx + SEARCH[i * 2] * search) * scale), y = Math.floor((sy + SEARCH[i * 2 + 1] * search) * scale);
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const t = y * w + x, zb = L.depth[t];
      if (zb < limit && L.id[t] !== self) { sum += zb; count++; }
    }
    if (!count) return 1;
    let penumbra = sh.softness * (z - sum / count) * sh.invTexel;
    penumbra = penumbra < .75 ? .75 : penumbra > sh.maxRadius ? sh.maxRadius : penumbra;
    let lf = Math.log2(penumbra / 2.5); if (lf < 0) lf = 0; if (lf > top) lf = top;
    const k0 = Math.floor(lf), t = k0 >= top ? 0 : lf - k0;
    // Blend the two pyramid levels around the penumbra size; skip the other level when its weight is negligible.
    if (t < .03) return pcf(sh, k0, sx, sy, penumbra, z, self);
    if (t > .97) return pcf(sh, k0 + 1, sx, sy, penumbra, z, self);
    const a = pcf(sh, k0, sx, sy, penumbra, z, self);
    return a + (pcf(sh, k0 + 1, sx, sy, penumbra, z, self) - a) * t;
  }

  // ---------------------------------------------------------------- per-pixel path
  const texel4 = new Float64Array(4);
  function drawExtended(job: Mesh3dKernelJobV1, pass: Mesh3dKernelPassV1, dr: Mesh3dKernelDrawV1, y0: number, y1: number): number {
    const m = dr.mat!, { width, height, depth } = job, rgba = job.writeRgba ? job.rgba : undefined, depthPrecise = job.depthPrecise, hdr = job.hdr, aoMask = job.aoMask;
    const attributes = dr.vertices, indices = dr.indices, texture = dr.texture, lt = pass.light, sh = m.receiveShadow ? pass.shadow : undefined, self = dr.id;
    const baseR = m.baseR, baseG = m.baseG, baseB = m.baseB, gridR = m.gridR, gridG = m.gridG, gridB = m.gridB;
    const hasStripes = m.hasStripes, hasGradient = m.hasGradient, hasGrid = m.hasGrid, hasWire = m.hasWire, wireFill = m.wireFill;
    const divU = m.divU, divV = m.divV, wireR = m.wireR, wireG = m.wireG, wireB = m.wireB, wireHalf = m.wireHalf;
    const sAr = m.sAr, sAg = m.sAg, sAb = m.sAb, sBr = m.sBr, sBg = m.sBg, sBb = m.sBb, stripeCos = m.stripeCos, stripeSin = m.stripeSin;
    const gAr = m.gAr, gAg = m.gAg, gAb = m.gAb, gBr = m.gBr, gBg = m.gBg, gBb = m.gBb;
    const hasEmissive = m.hasEmissive, emR = m.emR, emG = m.emG, emB = m.emB;
    const hasRim = m.hasRim, rimR = m.rimR, rimG = m.rimG, rimB = m.rimB, rimPower = m.rimPower;
    const specStrength = m.specStrength, shininess = m.shininess;
    const hasReflection = m.hasReflection, reflK = m.reflK, skyR = m.skyR, skyG = m.skyG, skyB = m.skyB, horR = m.horR, horG = m.horG, horB = m.horB, grR = m.grR, grG = m.grG, grB = m.grB;
    const hasGgx = m.hasGgx, ggxAlpha = m.ggxAlpha, ggxA2 = m.ggxA2, ggxNorm = m.ggxNorm, roughness = m.roughness;
    const hasGridStyle = m.hasGridStyle, cellsU = m.gridCellsU, cellsV = m.gridCellsV, gridHalf = m.gridHalf, gsR = m.gsR, gsG = m.gsG, gsB = m.gsB, fadeStart = m.gridFadeStart, fadeEnd = m.gridFadeEnd;
    const hasGridFade = hasGridStyle && fadeEnd > fadeStart, aoWeight = m.aoWeight;
    const texMode = texture ? texture.filter : 0, texAlpha = Boolean(texture && texture.alpha);
    const mask = dr.mask, levels = mask?.levels, repeat = mask?.repeat ?? 1;
    const needsDerivatives = Boolean(hasStripes || hasWire || mask || hasGridStyle || texMode === 3);
    const lx = lt.lx, ly = lt.ly, lz = lt.lz, keyI = lt.keyI, ambient = lt.ambient, wrap = lt.wrap;
    const hasFill = lt.hasFill, fx = lt.fx, fy = lt.fy, fz = lt.fz, fillR = lt.fillR, fillG = lt.fillG, fillB = lt.fillB, fillI = lt.fillI;
    const hasHemi = lt.hasHemi, hemiI = lt.hemiI, hgR = lt.hgR, hgG = lt.hgG, hgB = lt.hgB, hdR = lt.hdR, hdG = lt.hdG, hdB = lt.hdB;
    const camX = lt.camX, camY = lt.camY, camZ = lt.camZ, unlit = m.unlit, doubleSided = m.doubleSided;
    const hasPoint = lt.hasPoint, ptX = lt.ptX, ptY = lt.ptY, ptZ = lt.ptZ, ptR = lt.ptR, ptR2 = ptR * ptR, falloffRef = lt.falloffRef;
    const zbuf: Float32Array | Float64Array = depthPrecise ?? depth;
    let rasterized = 0;
    const tri = new Float64Array(3 * STRIDE), needsView = specStrength > 0 || hasRim || hasReflection;
    const needsWorld = needsView || Boolean(sh) || hasGridFade || hasPoint;
    const load = (slot: number, source: ArrayLike<number>, offset: number) => { for (let j = 0; j < STRIDE; j++) tri[slot * STRIDE + j] = source[offset + j]; };
    const copy = (index: number) => Array.from(attributes.subarray(index * STRIDE, index * STRIDE + STRIDE));
    for (let index = 0; index < indices.length; index += 3) {
      const ia = indices[index] * STRIDE, ib = indices[index + 1] * STRIDE, ic = indices[index + 2] * STRIDE;
      let outside = false, rejected = false;
      for (let side = 0; side < 6; side++) {
        const negatives = Number(clipDistance(attributes, ia, side) < 0) + Number(clipDistance(attributes, ib, side) < 0) + Number(clipDistance(attributes, ic, side) < 0);
        if (negatives === 3) { rejected = true; break; } if (negatives) outside = true;
      }
      if (rejected) continue;
      const polygon = outside ? clipTriangle([copy(indices[index]), copy(indices[index + 1]), copy(indices[index + 2])]) : undefined;
      const corners = polygon ? polygon.length : 3;
      for (let k = 1; k < corners - 1; k++) {
        if (polygon) { load(0, polygon[0], 0); load(1, polygon[k], 0); load(2, polygon[k + 1], 0); }
        else { load(0, attributes, ia); load(1, attributes, ib); load(2, attributes, ic); }
        const qa = 1 / tri[3], qb = 1 / tri[STRIDE + 3], qc = 1 / tri[2 * STRIDE + 3];
        const ax = (tri[0] * qa * .5 + .5) * width, ay = (.5 - tri[1] * qa * .5) * height;
        const bx = (tri[STRIDE] * qb * .5 + .5) * width, by = (.5 - tri[STRIDE + 1] * qb * .5) * height;
        const cx = (tri[2 * STRIDE] * qc * .5 + .5) * width, cy = (.5 - tri[2 * STRIDE + 1] * qc * .5) * height;
        const area = (cx - ax) * (by - ay) - (cy - ay) * (bx - ax);
        if (Math.abs(area) < 1e-8 || (!doubleSided && area <= 0)) continue;
        const flip = area < 0 ? -1 : 1;
        const minX = Math.max(0, Math.ceil(Math.min(ax, bx, cx) - .5)), maxX = Math.min(width - 1, Math.floor(Math.max(ax, bx, cx) - .5));
        const minY = Math.max(0, Math.ceil(Math.min(ay, by, cy) - .5)), maxY = Math.min(height - 1, Math.floor(Math.max(ay, by, cy) - .5));
        if (minX > maxX || minY > maxY) continue;
        if (minY >= y0 && minY < y1) rasterized++;
        const rowStart = Math.max(minY, y0), rowEnd = Math.min(maxY, y1 - 1);
        if (rowStart > rowEnd) continue;
        const za = tri[2] * qa, zb = tri[STRIDE + 2] * qb, zc = tri[2 * STRIDE + 2] * qc;
        // Vertex attributes as locals (monomorphic, register friendly).
        const u0 = tri[4], u1 = tri[STRIDE + 4], u2 = tri[2 * STRIDE + 4], v0 = tri[5], v1 = tri[STRIDE + 5], v2 = tri[2 * STRIDE + 5];
        const n0x = tri[6], n0y = tri[7], n0z = tri[8], n1x = tri[STRIDE + 6], n1y = tri[STRIDE + 7], n1z = tri[STRIDE + 8], n2x = tri[2 * STRIDE + 6], n2y = tri[2 * STRIDE + 7], n2z = tri[2 * STRIDE + 8];
        const p0x = tri[9], p0y = tri[10], p0z = tri[11], p1x = tri[STRIDE + 9], p1y = tri[STRIDE + 10], p1z = tri[STRIDE + 11], p2x = tri[2 * STRIDE + 9], p2y = tri[2 * STRIDE + 10], p2z = tri[2 * STRIDE + 11];
        const g0 = tri[12], g1 = tri[STRIDE + 12], g2 = tri[2 * STRIDE + 12];
        const dax = (cy - by) / area, day = -(cx - bx) / area, dbx = (ay - cy) / area, dby = -(ax - cx) / area, dcx = -dax - dbx;
        // Perspective-correct numerators are affine in screen space: their derivatives are per-triangle constants.
        const uq0 = u0 * qa, uq1 = u1 * qb, uq2 = u2 * qc, vq0 = v0 * qa, vq1 = v1 * qb, vq2 = v2 * qc;
        const dDx = dax * (qa - qc) + dbx * (qb - qc), dDy = day * (qa - qc) + dby * (qb - qc);
        const dUx = dax * (uq0 - uq2) + dbx * (uq1 - uq2), dUy = day * (uq0 - uq2) + dby * (uq1 - uq2), dVx = dax * (vq0 - vq2) + dbx * (vq1 - vq2), dVy = day * (vq0 - vq2) + dby * (vq1 - vq2);
        for (let y = rowStart; y <= rowEnd; y++) {
          const py = y + .5, x0c = minX + .5;
          const waRow = ((x0c - bx) * (cy - by) - (py - by) * (cx - bx)) / area, wbRow = ((x0c - cx) * (ay - cy) - (py - cy) * (ax - cx)) / area, wcRow = 1 - waRow - wbRow;
          // Covered span of this row from the three half-planes (one pixel of slack, then exact tests).
          let lo = minX, hi = maxX;
          if (dax > 1e-12) lo = Math.max(lo, minX + Math.floor((-1e-9 - waRow) / dax)); else if (dax < -1e-12) hi = Math.min(hi, minX + Math.ceil((-1e-9 - waRow) / dax)); else if (waRow < -1e-9) continue;
          if (dbx > 1e-12) lo = Math.max(lo, minX + Math.floor((-1e-9 - wbRow) / dbx)); else if (dbx < -1e-12) hi = Math.min(hi, minX + Math.ceil((-1e-9 - wbRow) / dbx)); else if (wbRow < -1e-9) continue;
          if (dcx > 1e-12) lo = Math.max(lo, minX + Math.floor((-1e-9 - wcRow) / dcx)); else if (dcx < -1e-12) hi = Math.min(hi, minX + Math.ceil((-1e-9 - wcRow) / dcx)); else if (wcRow < -1e-9) continue;
          if (lo > hi) continue;
          let wa = waRow + dax * (lo - minX), wb = wbRow + dbx * (lo - minX);
          for (let x = lo; x <= hi; x++, wa += dax, wb += dbx) {
            const wc = 1 - wa - wb;
            if (wa < -1e-9 || wb < -1e-9 || wc < -1e-9) continue;
            const d = wa * za + wb * zb + wc * zc, pixel = y * width + x;
            if (d >= zbuf[pixel]) continue;
            const pa = wa * qa, pb = wb * qb, pc = wc * qc, inv = 1 / (pa + pb + pc), ka = pa * inv, kb = pb * inv, kc = pc * inv;
            const u = ka * u0 + kb * u1 + kc * u2, v = ka * v0 + kb * v1 + kc * v2;
            let dudx = 0, dudy = 0, dvdx = 0, dvdy = 0;
            if (needsDerivatives) { dudx = (dUx - u * dDx) * inv; dudy = (dUy - u * dDy) * inv; dvdx = (dVx - v * dDx) * inv; dvdy = (dVy - v * dDy) * inv; }
            let wx = 0, wy = 0, wz = 0;
            if (needsWorld) { wx = ka * p0x + kb * p1x + kc * p2x; wy = ka * p0y + kb * p1y + kc * p2y; wz = ka * p0z + kb * p1z + kc * p2z; }
            // Pigment and coverage.
            let r = baseR, g = baseG, b = baseB, alpha = 1;
            if (texAlpha && u !== u) continue; // an alpha card is its textured face (uvMode leaves the rest uncovered)
            if (texture && u === u) {
              if (texMode === 0) {
                const tx = Math.max(0, Math.min(texture.width - 1, u * (texture.width - 1))), ty = Math.max(0, Math.min(texture.height - 1, (1 - v) * (texture.height - 1)));
                const x0 = tx | 0, y0_ = ty | 0, x1 = Math.min(texture.width - 1, x0 + 1), y1_ = Math.min(texture.height - 1, y0_ + 1), fx_ = tx - x0, fy_ = ty - y0_, t = texture.rgba, tw = texture.width;
                const p00 = (y0_ * tw + x0) * 4, p10 = (y0_ * tw + x1) * 4, p01 = (y1_ * tw + x0) * 4, p11 = (y1_ * tw + x1) * 4;
                const w00 = (1 - fx_) * (1 - fy_), w10 = fx_ * (1 - fy_), w01 = (1 - fx_) * fy_, w11 = fx_ * fy_;
                r = (t[p00] * w00 + t[p10] * w10 + t[p01] * w01 + t[p11] * w11) / 255; g = (t[p00 + 1] * w00 + t[p10 + 1] * w10 + t[p01 + 1] * w01 + t[p11 + 1] * w11) / 255; b = (t[p00 + 2] * w00 + t[p10 + 2] * w10 + t[p01 + 2] * w01 + t[p11 + 2] * w11) / 255;
              } else {
                sampleTexture(texture, u, v, dudx, dudy, dvdx, dvdy, texel4);
                r = texel4[0]; g = texel4[1]; b = texel4[2];
                if (texAlpha) alpha *= texel4[3];
              }
            } else if (hasStripes) {
              const s = u * stripeCos + v * stripeSin, sw = Math.abs(dudx * stripeCos + dvdx * stripeSin) + Math.abs(dudy * stripeCos + dvdy * stripeSin);
              const mix = sw > 1e-6 ? (squareIntegral(s + sw / 2) - squareIntegral(s - sw / 2)) / sw : (s / 2 - Math.floor(s / 2) >= .5 ? 1 : 0);
              r = sAr + sBr * mix; g = sAg + sBg * mix; b = sAb + sBb * mix;
            } else if (hasGradient) {
              const t = Math.max(0, Math.min(1, ka * g0 + kb * g1 + kc * g2));
              r = gAr + gBr * t; g = gAg + gBg * t; b = gAb + gBb * t;
            } else if (hasGridStyle) {
              // Antialiased lines `lineWidthPx` wide, fading out where cells shrink below a few pixels and with distance.
              const gu = u * cellsU, gv = v * cellsV;
              const lu = Math.sqrt(dudx * dudx + dudy * dudy) * cellsU, lv = Math.sqrt(dvdx * dvdx + dvdy * dvdy) * cellsV;
              const cu = Math.max(0, Math.min(1, gridHalf + .5 - Math.abs(gu - Math.round(gu)) / Math.max(lu, 1e-9))) * Math.max(0, Math.min(1, (.35 - lu) / .25));
              const cv = Math.max(0, Math.min(1, gridHalf + .5 - Math.abs(gv - Math.round(gv)) / Math.max(lv, 1e-9))) * Math.max(0, Math.min(1, (.35 - lv) / .25));
              let coverage = cu > cv ? cu : cv;
              if (hasGridFade && coverage > 0) {
                const dx = wx - camX, dy = wy - camY, dz = wz - camZ, distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
                let f = (distance - fadeStart) / (fadeEnd - fadeStart); f = f <= 0 ? 0 : f >= 1 ? 1 : f;
                coverage *= 1 - f * f * (3 - 2 * f);
              }
              r += (gsR - r) * coverage; g += (gsG - g) * coverage; b += (gsB - b) * coverage;
            } else if (hasGrid && (Math.abs((u * 12) % 1 - .5) > .475 || Math.abs((v * 12) % 1 - .5) > .475)) { r = gridR; g = gridG; b = gridB; }
            if (levels) {
              const mu = u * repeat, l0 = levels[0], ex = dudx * repeat * l0.width, ey = dvdx * l0.height, fx2 = dudy * repeat * l0.width, fy2 = dvdy * l0.height;
              const rho = Math.sqrt(Math.max(ex * ex + ey * ey, fx2 * fx2 + fy2 * fy2));
              const level = Math.max(0, Math.min(levels.length - 1, Math.floor(Math.log2(Math.max(1, rho)))));
              let a = sampleLevel(levels[level], mu - Math.floor(mu), v);
              if (rho < 1) a = Math.max(0, Math.min(1, (a - .5) * Math.min(6, 1 / Math.max(rho, 1e-3)) + .5));
              alpha *= a;
            }
            if (hasWire) {
              const gu = u * divU, gv = v * divV;
              const lu = Math.sqrt(dudx * dudx + dudy * dudy) * divU, lv = Math.sqrt(dvdx * dvdx + dvdy * dvdy) * divV;
              const cu = Math.max(0, Math.min(1, wireHalf + .5 - Math.abs(gu - Math.round(gu)) / Math.max(lu, 1e-9))) * Math.max(0, Math.min(1, (.45 - lu) / .3));
              const cv = Math.max(0, Math.min(1, wireHalf + .5 - Math.abs(gv - Math.round(gv)) / Math.max(lv, 1e-9))) * Math.max(0, Math.min(1, (.45 - lv) / .3));
              const coverage = cu > cv ? cu : cv;
              if (wireFill) { r += (wireR - r) * coverage; g += (wireG - g) * coverage; b += (wireB - b) * coverage; }
              else { r = wireR; g = wireG; b = wireB; alpha *= coverage; }
            }
            if (alpha <= 1 / 512) continue;
            // Lighting.
            let nx = ka * n0x + kb * n1x + kc * n2x, ny = ka * n0y + kb * n1y + kc * n2y, nz = ka * n0z + kb * n1z + kc * n2z;
            const nl = flip / (Math.sqrt(nx * nx + ny * ny + nz * nz) || 1); nx *= nl; ny *= nl; nz *= nl;
            let lr = 1, lg = 1, lb = 1, keyShadow = 1;
            // Key light direction at this pixel: constant for a directional key, toward the sphere light's centre otherwise.
            let klx = lx, kly = ly, klz = lz, atten = 1, lightDistance = 0;
            if (hasPoint) {
              const Lx = ptX - wx, Ly = ptY - wy, Lz = ptZ - wz, d2 = Lx * Lx + Ly * Ly + Lz * Lz;
              lightDistance = Math.sqrt(d2) || 1e-9; klx = Lx / lightDistance; kly = Ly / lightDistance; klz = Lz / lightDistance; atten = falloffRef / (d2 + ptR2);
            }
            if (!unlit) {
              if (sh || wrap > 0 || hasPoint) {
                const ndl = nx * klx + ny * kly + nz * klz;
                if (sh && ndl > -wrap) keyShadow = 1 - sh.strength * (1 - shadowLit(sh, wx, wy, wz, nx, ny, nz, self));
                const diffuse = wrap > 0 ? (ndl + wrap) / (1 + wrap) : ndl;
                const key = ambient + keyI * atten * Math.max(0, diffuse) * keyShadow;
                lr = key; lg = key; lb = key;
              } else {
                const key = ambient + keyI * Math.max(0, nx * lx + ny * ly + nz * lz);
                lr = key; lg = key; lb = key;
              }
              if (hasFill) { const f = fillI * Math.max(0, nx * fx + ny * fy + nz * fz); lr += f * fillR; lg += f * fillG; lb += f * fillB; }
              if (hasHemi) { const t = .5 + .5 * ny; lr += hemiI * (hgR + hdR * t); lg += hemiI * (hgG + hdG * t); lb += hemiI * (hgB + hdB * t); }
              if (lr > 1.15) lr = 1.15; if (lg > 1.15) lg = 1.15; if (lb > 1.15) lb = 1.15;
            } else if (sh) {
              // Unlit shadow catcher (receiveShadow: true on an unlit material, e.g. a UI screen under floating cards).
              const ndl = nx * klx + ny * kly + nz * klz;
              if (ndl > 0) { keyShadow = 1 - sh.strength * (1 - shadowLit(sh, wx, wy, wz, nx, ny, nz, self)); lr = keyShadow; lg = keyShadow; lb = keyShadow; }
            }
            r *= lr; g *= lg; b *= lb;
            if (needsView) {
              let vx = camX - wx, vy = camY - wy, vz = camZ - wz;
              const vl = 1 / (Math.sqrt(vx * vx + vy * vy + vz * vz) || 1); vx *= vl; vy *= vl; vz *= vl;
              const ndv = nx * vx + ny * vy + nz * vz;
              if (hasReflection) {
                const ry = 2 * ndv * ny - vy, k = reflK;
                let er: number, eg: number, eb: number, streak: number;
                if (roughness > 0) {
                  // Rough chrome: wider horizon/ground falloff and energy-preserving wider streaks.
                  const up = .35 + roughness * .5, down = .1 + roughness * .6, s1 = .0004 + roughness * roughness * .06, s2 = .0064 + roughness * roughness * .08;
                  if (ry >= 0) { let t = Math.min(1, ry / up); t = t * t * (3 - 2 * t); er = horR + (skyR - horR) * t; eg = horG + (skyG - horG) * t; eb = horB + (skyB - horB) * t; }
                  else { let t = Math.min(1, -ry / down); t = t * t * (3 - 2 * t); er = horR + (grR - horR) * t; eg = horG + (grG - horG) * t; eb = horB + (grB - horB) * t; }
                  streak = .9 * Math.sqrt(.0004 / s1) * Math.exp(-(ry - .02) * (ry - .02) / s1) + .5 * Math.sqrt(.0064 / s2) * Math.exp(-(ry - .55) * (ry - .55) / s2);
                } else {
                  // Studio environment: bright horizon, quick fall to a dark ground (the chrome line), a soft box overhead.
                  if (ry >= 0) { let t = Math.min(1, ry / .35); t = t * t * (3 - 2 * t); er = horR + (skyR - horR) * t; eg = horG + (skyG - horG) * t; eb = horB + (skyB - horB) * t; }
                  else { let t = Math.min(1, -ry / .1); t = t * t * (3 - 2 * t); er = horR + (grR - horR) * t; eg = horG + (grG - horG) * t; eb = horB + (grB - horB) * t; }
                  streak = .9 * Math.exp(-(ry - .02) * (ry - .02) / .0004) + .5 * Math.exp(-(ry - .55) * (ry - .55) / .0064);
                }
                r += ((er + streak) - r) * k; g += ((eg + streak) - g) * k; b += ((eb + streak) - b) * k;
              }
              if (specStrength > 0) {
                let hx = klx + vx, hy = kly + vy, hz = klz + vz; const hl = 1 / (Math.sqrt(hx * hx + hy * hy + hz * hz) || 1);
                const nh = (nx * hx + ny * hy + nz * hz) * hl;
                if (hasGgx) {
                  // Peak-normalised GGX lobe, widened by the key light's size (normalised by (α/α')²).
                  const ndl = nx * klx + ny * kly + nz * klz, facing = ndl <= 0 ? 0 : ndl >= .25 ? 1 : ndl * 4;
                  if (hasPoint && facing > 0) {
                    // Sphere light: the point on the light nearest the reflected ray (representative point), widened by its apparent size.
                    const rx = 2 * ndv * nx - vx, rry = 2 * ndv * ny - vy, rz = 2 * ndv * nz - vz;
                    const Lx = ptX - wx, Ly = ptY - wy, Lz = ptZ - wz, along = Lx * rx + Ly * rry + Lz * rz;
                    const cx = along * rx - Lx, cy = along * rry - Ly, cz = along * rz - Lz, cl = Math.sqrt(cx * cx + cy * cy + cz * cz), t = cl > ptR ? ptR / cl : 1;
                    let sx = Lx + cx * t, sy = Ly + cy * t, sz = Lz + cz * t; const sl = 1 / (Math.sqrt(sx * sx + sy * sy + sz * sz) || 1); sx *= sl; sy *= sl; sz *= sl;
                    let qx = sx + vx, qy = sy + vy, qz = sz + vz; const ql = 1 / (Math.sqrt(qx * qx + qy * qy + qz * qz) || 1); qx *= ql; qy *= ql; qz *= ql;
                    const nq = nx * qx + ny * qy + nz * qz, wide = Math.min(1, ggxAlpha + ptR / (2 * lightDistance)), a2 = wide * wide;
                    if (nq > 0) { const q = a2 / (nq * nq * (a2 - 1) + 1), norm = (ggxAlpha / wide) * (ggxAlpha / wide), s = specStrength * keyI * atten * q * q * norm * facing * keyShadow; r += s; g += s; b += s; }
                  } else if (nh > 0 && facing > 0) { const q = ggxA2 / (nh * nh * (ggxA2 - 1) + 1), s = specStrength * keyI * atten * q * q * ggxNorm * facing * keyShadow; r += s; g += s; b += s; }
                  if (hasFill) {
                    hx = fx + vx; hy = fy + vy; hz = fz + vz; const gl = 1 / (Math.sqrt(hx * hx + hy * hy + hz * hz) || 1);
                    const nf = (nx * hx + ny * hy + nz * hz) * gl, ndf = nx * fx + ny * fy + nz * fz, ff = ndf <= 0 ? 0 : ndf >= .25 ? 1 : ndf * 4;
                    if (nf > 0 && ff > 0) { const q = ggxA2 / (nf * nf * (ggxA2 - 1) + 1), t = specStrength * fillI * q * q * ggxNorm * ff; r += t * fillR; g += t * fillG; b += t * fillB; }
                  }
                } else {
                  if (nh > 0) { let s = specStrength * keyI * Math.pow(nh, shininess); if (keyShadow !== 1) s *= keyShadow; if (hasPoint) s *= atten; r += s; g += s; b += s; }
                  if (hasFill) {
                    hx = fx + vx; hy = fy + vy; hz = fz + vz; const gl = 1 / (Math.sqrt(hx * hx + hy * hy + hz * hz) || 1);
                    const nf = (nx * hx + ny * hy + nz * hz) * gl;
                    if (nf > 0) { const t = specStrength * fillI * Math.pow(nf, shininess); r += t * fillR; g += t * fillG; b += t * fillB; }
                  }
                }
              }
              if (hasRim) { const f = Math.pow(1 - (ndv < 0 ? 0 : ndv > 1 ? 1 : ndv), rimPower); r += rimR * f; g += rimG * f; b += rimB * f; }
            }
            if (hasEmissive) { r += emR; g += emG; b += emB; }
            const p = pixel * 4;
            if (alpha >= 1) {
              if (rgba) { rgba[p] = r * 255; rgba[p + 1] = g * 255; rgba[p + 2] = b * 255; }
              if (hdr) { hdr[pixel * 3] = r; hdr[pixel * 3 + 1] = g; hdr[pixel * 3 + 2] = b; }
            } else {
              if (rgba) { rgba[p] += (r * 255 - rgba[p]) * alpha; rgba[p + 1] += (g * 255 - rgba[p + 1]) * alpha; rgba[p + 2] += (b * 255 - rgba[p + 2]) * alpha; }
              if (hdr) { hdr[pixel * 3] += (r - hdr[pixel * 3]) * alpha; hdr[pixel * 3 + 1] += (g - hdr[pixel * 3 + 1]) * alpha; hdr[pixel * 3 + 2] += (b - hdr[pixel * 3 + 2]) * alpha; }
              if (alpha < .5) continue;
            }
            depth[pixel] = d;
            if (depthPrecise) depthPrecise[pixel] = d;
            if (aoMask) aoMask[pixel] = aoWeight;
          }
        }
      }
    }
    return rasterized;
  }

  // ---------------------------------------------------------------- post: shared pieces
  const smooth = (a: number, b: number, x: number) => { const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a); return t * t * (3 - 2 * t); };
  function boxSizes(sigma: number): number[] {
    const n = 3, ideal = Math.sqrt(12 * sigma * sigma / n + 1);
    let lower = Math.floor(ideal); if (lower % 2 === 0) lower--;
    const upper = lower + 2, m = Math.round((12 * sigma * sigma - n * lower * lower - 4 * n * lower - 3 * n) / (-4 * lower - 4));
    return Array.from({ length: n }, (_, i) => i < m ? lower : upper);
  }
  /** Running-box filter of lines [l0, l1): rows when horizontal, columns otherwise. */
  function boxLines(src: Float32Array, dst: Float32Array, w: number, h: number, channels: number, radius: number, horizontal: boolean, l0: number, l1: number): void {
    const length = horizontal ? w : h, stride = horizontal ? channels : w * channels;
    if (radius < 1) {
      if (horizontal) { dst.set(src.subarray(l0 * w * channels, l1 * w * channels), l0 * w * channels); return; }
      for (let line = l0; line < l1; line++) for (let i = 0; i < length; i++) for (let c = 0; c < channels; c++) { const o = line * channels + i * stride + c; dst[o] = src[o]; }
      return;
    }
    const inv = 1 / (2 * radius + 1);
    if (!horizontal) {
      // Columns [l0, l1) walked row by row (cache friendly); each column keeps its own running sum with
      // exactly the per-column arithmetic of the line loop below.
      const rowStride = w * channels, c0 = l0 * channels, span = (l1 - l0) * channels, lastRow = (h - 1) * rowStride, acc = new Float64Array(span);
      for (let k = 0; k < span; k++) {
        const s0 = c0 + k; let a = src[s0] * (radius + 1);
        for (let i = 1; i <= radius; i++) a += src[s0 + Math.min(i, h - 1) * rowStride];
        acc[k] = a;
      }
      for (let i = 0; i < h; i++) {
        const out = i * rowStride + c0, add = i + radius + 1, remove = i - radius;
        const addRow = add < h ? add * rowStride : lastRow, removeRow = remove >= 0 ? remove * rowStride : 0;
        for (let k = 0; k < span; k++) { dst[out + k] = acc[k] * inv; acc[k] += src[addRow + c0 + k] - src[removeRow + c0 + k]; }
      }
      return;
    }
    for (let line = l0; line < l1; line++) {
      const start = horizontal ? line * w * channels : line * channels;
      for (let c = 0; c < channels; c++) {
        const s0 = start + c, first = src[s0], last = src[s0 + (length - 1) * stride];
        let acc = first * (radius + 1);
        for (let i = 1; i <= radius; i++) acc += src[s0 + Math.min(i, length - 1) * stride];
        for (let i = 0; i < length; i++) {
          dst[s0 + i * stride] = acc * inv;
          const add = i + radius + 1, remove = i - radius;
          acc += (add < length ? src[s0 + add * stride] : last) - (remove >= 0 ? src[s0 + remove * stride] : first);
        }
      }
    }
  }
  /** Approximate Gaussian (three box passes per axis), in place; `temp` is scratch of the same length. */
  function blur(ctx: Mesh3dKernelCtxV1, buffer: Float32Array, temp: Float32Array, w: number, h: number, channels: number, sigma: number): void {
    if (!(sigma > .2)) return;
    for (const size of boxSizes(sigma)) {
      const r = (size - 1) / 2;
      each(ctx, h, QROWS, (a, b) => boxLines(buffer, temp, w, h, channels, r, true, a, b)); ctx.sync();
      each(ctx, w, COLS, (a, b) => boxLines(temp, buffer, w, h, channels, r, false, a, b)); ctx.sync();
    }
  }
  /** `buffer` = blur(copy of `source`): the first horizontal pass reads `source` directly (same values, one phase fewer). */
  function blurFrom(ctx: Mesh3dKernelCtxV1, source: Float32Array, buffer: Float32Array, temp: Float32Array, w: number, h: number, channels: number, sigma: number): void {
    if (!(sigma > .2)) { copyPhase(ctx, source, buffer, h, w * channels); return; }
    let from = source;
    for (const size of boxSizes(sigma)) {
      const r = (size - 1) / 2, src = from;
      each(ctx, h, QROWS, (a, b) => boxLines(src, temp, w, h, channels, r, true, a, b)); ctx.sync();
      each(ctx, w, COLS, (a, b) => boxLines(temp, buffer, w, h, channels, r, false, a, b)); ctx.sync();
      from = buffer;
    }
  }
  function copyPhase(ctx: Mesh3dKernelCtxV1, src: Float32Array, dst: Float32Array, rows: number, rowLength: number): void {
    each(ctx, rows, QROWS, (a, b) => dst.set(src.subarray(a * rowLength, b * rowLength), a * rowLength)); ctx.sync();
  }
  function zeroPhase(ctx: Mesh3dKernelCtxV1, buffers: Float32Array[], rows: number, rowLengths: number[]): void {
    each(ctx, rows, QROWS, (a, b) => { buffers.forEach((buffer, i) => buffer.fill(0, a * rowLengths[i], b * rowLengths[i])); }); ctx.sync();
  }
  /** Bilinear lookup tables from full-resolution pixels into a quarter-resolution grid. */
  function quarterTaps(full: number, quarter: number) {
    const i0 = new Int32Array(full), i1 = new Int32Array(full), f = new Float32Array(full);
    for (let x = 0; x < full; x++) {
      const s = Math.max(0, Math.min(quarter - 1, (x + .5) / QUARTER - .5)), a = Math.floor(s);
      i0[x] = a; i1[x] = Math.min(quarter - 1, a + 1); f[x] = s - a;
    }
    return { i0, i1, f };
  }

  // ---------------------------------------------------------------- post: ambient occlusion
  /**
   * Screen-space AO at half resolution: 12 taps on a spiral (rotated by a 4×4 Bayer index,
   * so the pattern averages out under the blur) test how far each neighbour rises above
   * the tangent plane; a depth-aware blur and a joint bilateral upsample keep it off
   * silhouettes. Only pixels of lit materials (the shading pass's mask) are darkened.
   */
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5], AO_TAPS = 12;
  const AO_DIRS = (() => {
    const out = new Float64Array(16 * AO_TAPS * 2);
    for (let r = 0; r < 16; r++) for (let s = 0; s < AO_TAPS; s++) {
      const angle = r / 16 * 6.283185307179586 + s * 2.399963229728653, t = (s + .5) / AO_TAPS;
      out[(r * AO_TAPS + s) * 2] = Math.cos(angle) * t; out[(r * AO_TAPS + s) * 2 + 1] = Math.sin(angle) * t;
    }
    return out;
  })();
  const AO_BLUR = [1, .88, .61, .32, .13]; // exp(-k² / 7.5), k = 0..4
  function applyAo(ctx: Mesh3dKernelCtxV1, post: Mesh3dKernelPostV1, w: number, h: number): void {
    const ao = post.ao!, depth = post.depth, color = post.color, linear = ao.linear, raw = ao.raw, tmp = ao.tmp, zh = ao.half, mask = ao.mask;
    const n = post.near, f = post.far, A = f + n, B = f - n, C2 = 2 * f * n, tanY = ao.tanHalfFov, tanX = tanY * ao.aspect, focal = h / (2 * tanY), radius = ao.radius, reach2 = radius * radius * 4;
    const hw = Math.ceil(w / 2), hh = Math.ceil(h / 2), sx = 2 * tanX / w, sy = 2 * tanY / h;
    each(ctx, h, ROWS, (y0, y1) => { for (let i = y0 * w; i < y1 * w; i++) { const d = depth[i]; linear[i] = d === Infinity ? Infinity : C2 / (A - d * B); } });
    ctx.sync();
    // View-space x/y of pixel (x, y) at distance z: ((x + .5)·sx − tanX)·z, (tanY − (y + .5)·sy)·z; view z = −z.
    each(ctx, hh, QROWS, (j0, j1) => {
      for (let j = j0; j < j1; j++) for (let i = 0; i < hw; i++) {
        const x = i * 2, y = j * 2, c = y * w + x, z = linear[c], o = j * hw + i;
        zh[o] = z;
        if (z === Infinity || !mask[c]) { raw[o] = 1; continue; }
        const px = ((x + .5) * sx - tanX) * z, py = (tanY - (y + .5) * sy) * z;
        // Normal from the flatter neighbour on each axis (no smearing across silhouettes).
        const zl = x > 0 ? linear[c - 1] : Infinity, zr = x < w - 1 ? linear[c + 1] : Infinity, zu = y > 0 ? linear[c - w] : Infinity, zd = y < h - 1 ? linear[c + w] : Infinity;
        const right = Math.abs(zr - z) < Math.abs(zl - z), down = Math.abs(zd - z) < Math.abs(zu - z);
        const hz = right ? zr : zl, vz = down ? zd : zu;
        if (hz === Infinity || vz === Infinity) { raw[o] = 1; continue; }
        const hx = right ? x + 1 : x - 1, vy = down ? y + 1 : y - 1, sgnH = right ? 1 : -1, sgnV = down ? 1 : -1;
        const ax = (((hx + .5) * sx - tanX) * hz - px) * sgnH, ay = ((tanY - (y + .5) * sy) * hz - py) * sgnH, az = (z - hz) * sgnH;
        const bx = (((x + .5) * sx - tanX) * vz - px) * sgnV, by = ((tanY - (vy + .5) * sy) * vz - py) * sgnV, bz = (z - vz) * sgnV;
        let nx = by * az - bz * ay, ny = bz * ax - bx * az, nz = bx * ay - by * ax;
        const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (!(nl > 0)) { raw[o] = 1; continue; }
        nx /= nl; ny /= nl; nz /= nl;
        if (nx * px + ny * py - nz * z > 0) { nx = -nx; ny = -ny; nz = -nz; }
        let rpx = radius * focal / z; if (rpx > h * .12) rpx = h * .12;
        if (rpx < 1.5) { raw[o] = 1; continue; }
        const table = BAYER[(j & 3) * 4 + (i & 3)] * AO_TAPS * 2;
        let occlusion = 0;
        for (let s = 0; s < AO_TAPS; s++) {
          const tx = Math.round(x + AO_DIRS[table + s * 2] * rpx), ty = Math.round(y + AO_DIRS[table + s * 2 + 1] * rpx);
          if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
          const zs = linear[ty * w + tx];
          if (zs === Infinity) continue;
          const vx = ((tx + .5) * sx - tanX) * zs - px, vyy = (tanY - (ty + .5) * sy) * zs - py, vzz = z - zs, vv = vx * vx + vyy * vyy + vzz * vzz;
          if (vv < 1e-12 || vv > reach2) continue;
          const cosine = (vx * nx + vyy * ny + vzz * nz) / Math.sqrt(vv) - .08;
          if (cosine > 0) occlusion += cosine * (1 - vv / reach2);
        }
        const a = 1 - occlusion * 2 / AO_TAPS;
        raw[o] = a < 0 ? 0 : a;
      }
    });
    ctx.sync();
    // Depth-aware separable blur (radius 4 half-res texels) removes the rotation pattern.
    const blurLine = (src: Float32Array, dst: Float32Array, o: number, step: number, position: number, count: number) => {
      const z = zh[o];
      if (z === Infinity) { dst[o] = src[o]; return; }
      const tolerance = 1 / (z * .05 + 1e-6), k0 = position < 4 ? -position : -4, k1 = count - 1 - position < 4 ? count - 1 - position : 4;
      let sum = 0, weight = 0;
      for (let k = k0; k <= k1; k++) {
        const q = o + k * step, zj = zh[q];
        if (zj === Infinity) continue;
        let dz = 1 - Math.abs(zj - z) * tolerance; if (dz <= 0) continue; dz *= dz;
        const wgt = AO_BLUR[k < 0 ? -k : k] * dz;
        sum += src[q] * wgt; weight += wgt;
      }
      dst[o] = weight > 0 ? sum / weight : src[o];
    };
    each(ctx, hh, QROWS, (j0, j1) => { for (let j = j0; j < j1; j++) for (let i = 0; i < hw; i++) blurLine(raw, tmp, j * hw + i, 1, i, hw); });
    ctx.sync();
    each(ctx, hw, COLS, (i0, i1) => { for (let i = i0; i < i1; i++) for (let j = 0; j < hh; j++) blurLine(tmp, raw, j * hw + i, hw, j, hh); });
    ctx.sync();
    // Joint bilateral upsample: bilinear weights × depth agreement with each half-res texel's source pixel.
    const strength = ao.strength;
    each(ctx, h, ROWS, (y0, y1) => {
      for (let y = y0; y < y1; y++) {
        // Half-res texel (i, j) samples full-res pixel (2i, 2j), so pixel (x, y) sits at (x / 2, y / 2).
        const j0 = Math.min(hh - 1, y >> 1), j1 = Math.min(hh - 1, j0 + 1), fy = y & 1 ? .5 : 0;
        for (let x = 0; x < w; x++) {
          const i = y * w + x, weight0 = mask[i], z = linear[i];
          if (!weight0 || z === Infinity) continue;
          const i0 = Math.min(hw - 1, x >> 1), i1 = Math.min(hw - 1, i0 + 1), fx = x & 1 ? .5 : 0, invZ = 1 / z;
          // Unoccluded neighbourhood (the common case): nothing to darken.
          if (raw[j0 * hw + i0] >= .999 && raw[j0 * hw + i1] >= .999 && raw[j1 * hw + i0] >= .999 && raw[j1 * hw + i1] >= .999) continue;
          let sum = 0, total = 0;
          for (let k = 0; k < 4; k++) {
            const bilinear = (k & 1 ? fx : 1 - fx) * (k & 2 ? fy : 1 - fy);
            if (bilinear === 0) continue;
            const t = (k & 2 ? j1 : j0) * hw + (k & 1 ? i1 : i0), zs = zh[t];
            if (zs === Infinity) continue;
            const wgt = bilinear / (1e-3 + Math.abs(zs - z) * invZ);
            sum += raw[t] * wgt; total += wgt;
          }
          if (!(total > 0)) continue;
          const k = 1 - strength * (1 - sum / total) * weight0 / 255;
          color[i * 3] *= k; color[i * 3 + 1] *= k; color[i * 3 + 2] *= k;
        }
      }
    });
    ctx.sync();
  }

  // ---------------------------------------------------------------- post: depth of field
  function applyDof(ctx: Mesh3dKernelCtxV1, post: Mesh3dKernelPostV1, w: number, h: number): void {
    const dof = post.dof!, color = post.color, depth = post.depth, n = post.near, f = post.far;
    const aperture = dof.aperture * h, maxCoc = Math.min(.05 * h, aperture * 2);
    if (maxCoc < 1) return;
    const coc = post.coc!, A = f + n, B = f - n, C2 = 2 * f * n, focus = dof.focusDistance;
    const C = 7, qw = Math.ceil(w / QUARTER), qh = Math.ceil(h / QUARTER), accumulated = post.dofQuarter!, counts = post.dofCounts!;
    const composite = post.dofComposite!;
    zeroPhase(ctx, [accumulated, counts, composite], qh, [qw * C, qw, qw * 5]);
    // Quarter grid of [r²·w, g²·w, b²·w, w, nearW, |coc|·nearW, |coc|·w] (squares ≈ linear light), accumulated directly.
    each(ctx, h, ROWS, (y0, y1) => {
      for (let y = y0; y < y1; y++) {
        const qrow = (y / QUARTER | 0) * qw;
        for (let x = 0; x < w; x++) {
          const i = y * w + x, d = depth[i];
          let k = aperture;
          if (d !== Infinity) { const distance = C2 / (A - d * B); k = aperture * (distance - focus) / distance; }
          if (k > maxCoc) k = maxCoc; else if (k < -maxCoc) k = -maxCoc;
          coc[i] = k;
          const q = qrow + (x / QUARTER | 0), o = q * C;
          counts[q]++;
          const magnitude = k < 0 ? -k : k;
          if (magnitude <= .5) continue;
          const weight = smooth(.5, 2, magnitude), r = color[i * 3], g = color[i * 3 + 1], b = color[i * 3 + 2];
          accumulated[o] += r * r * weight; accumulated[o + 1] += g * g * weight; accumulated[o + 2] += b * b * weight; accumulated[o + 3] += weight; accumulated[o + 6] += magnitude * weight;
          // Only clearly out-of-focus near pixels spill over what lies behind them.
          if (k < -1) { const nearWeight = smooth(1, 3, magnitude); accumulated[o + 4] += nearWeight; accumulated[o + 5] += magnitude * nearWeight; }
        }
      }
    });
    ctx.sync();
    each(ctx, qh, QROWS, (a, b) => { for (let q = a * qw; q < b * qw; q++) { const inv = 1 / counts[q]; for (let c = 0; c < C; c++) accumulated[q * C + c] *= inv; } });
    ctx.sync();
    const sigmas = [maxCoc / 8, maxCoc / 4, maxCoc / 2], levels = post.dofLevels!, temp = post.dofTemp!;
    let previous = 0, current = accumulated;
    for (let l = 0; l < 3; l++) {
      const sigma = sigmas[l], next = levels[l];
      blurFrom(ctx, current, next, temp, qw, qh, C, Math.sqrt(sigma * sigma - previous * previous) / QUARTER);
      previous = sigma; current = next;
    }
    // Per quarter texel: the blurred colour for the local circle of confusion (or the spill of a near
    // object over it), as [r, g, b, valid, nearA]. Texels with no out-of-focus pixel nearby stay invalid.
    const [L1, L2, L3] = levels;
    each(ctx, qh, QROWS, (qa, qb) => {
      const level = (L: Float32Array, q: number, out: number[]) => { const wgt = L[q * C + 3]; if (wgt <= 1e-5) return false; out[0] = Math.sqrt(L[q * C] / wgt); out[1] = Math.sqrt(L[q * C + 1] / wgt); out[2] = Math.sqrt(L[q * C + 2] / wgt); return true; };
      const a: number[] = [0, 0, 0], b: number[] = [0, 0, 0];
      for (let q = qa * qw; q < qb * qw; q++) {
        const w1 = L1[q * C + 3], cocEstimate = w1 > 1e-4 ? L1[q * C + 6] / w1 : 0, nearW = L3[q * C + 4];
        const nearSigma = nearW > 1e-3 ? L3[q * C + 5] / nearW / 2 : 0, nearA = Math.min(1, nearW * 2) * smooth(.5, 2, nearSigma);
        const sigma = Math.min(sigmas[2], Math.max(cocEstimate / 2, nearA > .01 ? nearSigma : 0));
        const lower = sigma <= sigmas[1] ? L1 : L2, upper = sigma <= sigmas[1] ? L2 : L3;
        const t = sigma <= sigmas[0] ? 0 : sigma <= sigmas[1] ? (sigma - sigmas[0]) / (sigmas[1] - sigmas[0]) : (sigma - sigmas[1]) / (sigmas[2] - sigmas[1]);
        const hasLower = level(lower, q, a), hasUpper = level(upper, q, b), o = q * 5;
        composite[o + 4] = nearA;
        if (!hasLower && !hasUpper) { if (level(L3, q, a)) { composite[o] = a[0]; composite[o + 1] = a[1]; composite[o + 2] = a[2]; composite[o + 3] = 1; } continue; }
        const u = !hasLower ? 1 : !hasUpper ? 0 : t;
        const lo = hasLower ? a : b, hi = hasUpper ? b : a;
        composite[o] = lo[0] + (hi[0] - lo[0]) * u; composite[o + 1] = lo[1] + (hi[1] - lo[1]) * u; composite[o + 2] = lo[2] + (hi[2] - lo[2]) * u; composite[o + 3] = 1;
      }
    });
    ctx.sync();
    // Full resolution: blend the sharp pixel toward the validity-weighted bilinear blur by its own CoC or the near spill.
    const tx = quarterTaps(w, qw), ty = quarterTaps(h, qh), halfInvSmallest = .5 / sigmas[0];
    each(ctx, h, ROWS, (y0, y1) => {
      for (let y = y0; y < y1; y++) {
        const ya = ty.i0[y] * qw, yb = ty.i1[y] * qw, fy = ty.f[y];
        for (let x = 0; x < w; x++) {
          const i = y * w + x, own = coc[i] < 0 ? -coc[i] : coc[i], xa = tx.i0[x], xb = tx.i1[x], fx = tx.f[x];
          const q00 = (ya + xa) * 5, q10 = (ya + xb) * 5, q01 = (yb + xa) * 5, q11 = (yb + xb) * 5;
          let w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
          const nearA = composite[q00 + 4] * w00 + composite[q10 + 4] * w10 + composite[q01 + 4] * w01 + composite[q11 + 4] * w11;
          // A small CoC blends partway toward the narrowest blur level (σ = maxCoc / 8).
          let ownAmount = own * halfInvSmallest; if (ownAmount > 1) ownAmount = 1; ownAmount = ownAmount * ownAmount * (3 - 2 * ownAmount);
          const amount = ownAmount > nearA ? ownAmount : nearA;
          if (amount <= 1e-3) continue;
          w00 *= composite[q00 + 3]; w10 *= composite[q10 + 3]; w01 *= composite[q01 + 3]; w11 *= composite[q11 + 3];
          const total = w00 + w10 + w01 + w11;
          if (total <= 1e-6) continue;
          const inv = amount / total, sr = color[i * 3], sg = color[i * 3 + 1], sb = color[i * 3 + 2];
          color[i * 3] = sr + ((composite[q00] * w00 + composite[q10] * w10 + composite[q01] * w01 + composite[q11] * w11) - sr * total) * inv;
          color[i * 3 + 1] = sg + ((composite[q00 + 1] * w00 + composite[q10 + 1] * w10 + composite[q01 + 1] * w01 + composite[q11 + 1] * w11) - sg * total) * inv;
          color[i * 3 + 2] = sb + ((composite[q00 + 2] * w00 + composite[q10 + 2] * w10 + composite[q01 + 2] * w01 + composite[q11 + 2] * w11) - sb * total) * inv;
        }
      }
    });
    ctx.sync();
  }

  // ---------------------------------------------------------------- post: bloom + finish
  function bloomGlow(ctx: Mesh3dKernelCtxV1, post: Mesh3dKernelPostV1, w: number, h: number): void {
    const bloom = post.bloom!, color = post.color, threshold = bloom.threshold, knee = Math.max(.05, threshold * .5);
    const qw = Math.ceil(w / QUARTER), qh = Math.ceil(h / QUARTER), data = post.bloomData!, counts = post.bloomCounts!, glow = post.bloomGlow!, layer = post.bloomLayer!, temp = post.bloomTemp!;
    zeroPhase(ctx, [data, counts, glow], qh, [qw * 3, qw, qw * 3]);
    each(ctx, h, ROWS, (y0, y1) => {
      for (let y = y0; y < y1; y++) {
        const qrow = (y / QUARTER | 0) * qw;
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 3, q = qrow + (x / QUARTER | 0), r = color[i], g = color[i + 1], b = color[i + 2], luma = .2126 * r + .7152 * g + .0722 * b;
          counts[q]++;
          if (luma <= threshold - knee) continue;
          const soft = Math.min(knee * 2, luma - threshold + knee), contribution = Math.max(soft * soft / (4 * knee), luma - threshold) / Math.max(luma, 1e-4);
          data[q * 3] += r * contribution; data[q * 3 + 1] += g * contribution; data[q * 3 + 2] += b * contribution;
        }
      }
    });
    ctx.sync();
    each(ctx, qh, QROWS, (a, b) => { for (let q = a * qw; q < b * qw; q++) { const inv = 1 / counts[q]; data[q * 3] *= inv; data[q * 3 + 1] *= inv; data[q * 3 + 2] *= inv; } });
    ctx.sync();
    const R = bloom.radius * h / QUARTER;
    for (const [sigma, weight] of [[R / 10, .45], [R / 3.5, .33], [R, .22]] as const) {
      blurFrom(ctx, data, layer, temp, qw, qh, 3, sigma);
      each(ctx, qh, QROWS, (a, b) => { for (let i = a * qw * 3; i < b * qw * 3; i++) glow[i] += layer[i] * weight * bloom.strength; });
      ctx.sync();
    }
  }
  /** Fisheye (barrel for strength > 0) + bloom glow + vignette + 8-bit output, by rows. */
  function finishRows(post: Mesh3dKernelPostV1, w: number, h: number, hasGlow: boolean, y0: number, y1: number): void {
    const color = post.color, rgba = post.out, k = post.fisheye?.strength ?? 0, vignette = post.vignette;
    const halfDiagonal2 = (w * w + h * h) / 4, cx = w / 2, cy = h / 2, norm = 1 + k;
    const vInner = vignette ? 1 - vignette.softness : 0, vStrength = vignette?.strength ?? 0, vSpan = 1 / (1.15 - vInner);
    const words = LITTLE ? new Uint32Array(rgba.buffer, rgba.byteOffset, w * h) : undefined;
    const gw = hasGlow ? Math.ceil(w / QUARTER) : 1, gh = hasGlow ? Math.ceil(h / QUARTER) : 1, g = hasGlow ? post.bloomGlow : undefined;
    const tx = g && k === 0 ? quarterTaps(w, gw) : undefined, ty = g && k === 0 ? quarterTaps(h, gh) : undefined;
    for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) {
      const dx = x + .5 - cx, dy = y + .5 - cy, r2 = (dx * dx + dy * dy) / halfDiagonal2;
      let r: number, gr: number, b: number, sx = x + .5, sy = y + .5;
      if (k !== 0) {
        // Corners map to themselves; the centre is magnified by (1 + k). Straight lines bow outward.
        const scale = (1 + k * r2) / norm; sx = cx + dx * scale; sy = cy + dy * scale;
        const fxp = sx - .5, fyp = sy - .5, x0 = Math.floor(fxp), y0_ = Math.floor(fyp), fx = fxp - x0, fy = fyp - y0_;
        const xa = x0 < 0 ? 0 : x0 >= w ? w - 1 : x0, xb = x0 + 1 < 0 ? 0 : x0 + 1 >= w ? w - 1 : x0 + 1, ya = y0_ < 0 ? 0 : y0_ >= h ? h - 1 : y0_, yb = y0_ + 1 < 0 ? 0 : y0_ + 1 >= h ? h - 1 : y0_ + 1;
        const p00 = (ya * w + xa) * 3, p10 = (ya * w + xb) * 3, p01 = (yb * w + xa) * 3, p11 = (yb * w + xb) * 3;
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        r = color[p00] * w00 + color[p10] * w10 + color[p01] * w01 + color[p11] * w11;
        gr = color[p00 + 1] * w00 + color[p10 + 1] * w10 + color[p01 + 1] * w01 + color[p11 + 1] * w11;
        b = color[p00 + 2] * w00 + color[p10 + 2] * w10 + color[p01 + 2] * w01 + color[p11 + 2] * w11;
      } else { const i = (y * w + x) * 3; r = color[i]; gr = color[i + 1]; b = color[i + 2]; }
      if (g && tx && ty) {
        const x0 = tx.i0[x], x1 = tx.i1[x], y0_ = ty.i0[y], y1_ = ty.i1[y], fx = tx.f[x], fy = ty.f[y];
        const p00 = (y0_ * gw + x0) * 3, p10 = (y0_ * gw + x1) * 3, p01 = (y1_ * gw + x0) * 3, p11 = (y1_ * gw + x1) * 3;
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        r += g[p00] * w00 + g[p10] * w10 + g[p01] * w01 + g[p11] * w11;
        gr += g[p00 + 1] * w00 + g[p10 + 1] * w10 + g[p01 + 1] * w01 + g[p11 + 1] * w11;
        b += g[p00 + 2] * w00 + g[p10 + 2] * w10 + g[p01 + 2] * w01 + g[p11 + 2] * w11;
      } else if (g) {
        const qx = Math.max(0, Math.min(gw - 1, sx / QUARTER - .5)), qy = Math.max(0, Math.min(gh - 1, sy / QUARTER - .5)), x0 = qx | 0, y0_ = qy | 0;
        const x1 = x0 + 1 < gw ? x0 + 1 : x0, y1_ = y0_ + 1 < gh ? y0_ + 1 : y0_, fx = qx - x0, fy = qy - y0_;
        const p00 = (y0_ * gw + x0) * 3, p10 = (y0_ * gw + x1) * 3, p01 = (y1_ * gw + x0) * 3, p11 = (y1_ * gw + x1) * 3;
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        r += g[p00] * w00 + g[p10] * w10 + g[p01] * w01 + g[p11] * w11;
        gr += g[p00 + 1] * w00 + g[p10 + 1] * w10 + g[p01 + 1] * w01 + g[p11 + 1] * w11;
        b += g[p00 + 2] * w00 + g[p10 + 2] * w10 + g[p01 + 2] * w01 + g[p11 + 2] * w11;
      }
      if (vStrength > 0) {
        let t = (Math.sqrt(r2) - vInner) * vSpan; t = t <= 0 ? 0 : t >= 1 ? 1 : t;
        const v = 1 - vStrength * t * t * (3 - 2 * t); r *= v; gr *= v; b *= v;
      }
      const pixel = y * w + x, R = r * 255 + .5, G = gr * 255 + .5, Bv = b * 255 + .5;
      if (words) words[pixel] = ((R <= 0 ? 0 : R >= 255 ? 255 : R | 0) | (G <= 0 ? 0 : G >= 255 ? 255 : G | 0) << 8 | (Bv <= 0 ? 0 : Bv >= 255 ? 255 : Bv | 0) << 16 | 255 << 24) >>> 0;
      else { const p = pixel * 4; rgba[p] = r * 255; rgba[p + 1] = gr * 255; rgba[p + 2] = b * 255; rgba[p + 3] = 255; }
    }
  }
  /**
   * Motion-blur gap fill: box-filter the averaged frame along the per-sample camera shift
   * (sx, sy pixels) so N sub-frame copies join into one streak.
   */
  function gapFill(ctx: Mesh3dKernelCtxV1, color: Float32Array, temp: Float32Array, w: number, h: number, sx: number, sy: number): void {
    const rx = Math.min(64, Math.round(Math.abs(sx) / 2)), ry = Math.min(64, Math.round(Math.abs(sy) / 2));
    if (rx < 1 && ry < 1) return;
    if (rx >= 1) { each(ctx, h, ROWS, (a, b) => boxLines(color, temp, w, h, 3, rx, true, a, b)); ctx.sync(); copyPhase(ctx, temp, color, h, w * 3); }
    if (ry >= 1) { each(ctx, w, COLS, (a, b) => boxLines(color, temp, w, h, 3, ry, false, a, b)); ctx.sync(); copyPhase(ctx, temp, color, h, w * 3); }
  }
  /** The post chain after the raster passes: gap fill → AO → DOF → bloom → finish. */
  function postPhases(ctx: Mesh3dKernelCtxV1, post: Mesh3dKernelPostV1, w: number, h: number): void {
    if (post.gap) gapFill(ctx, post.color, post.gapTemp!, w, h, post.gap.sx, post.gap.sy);
    if (post.ao && post.ao.strength > 0) applyAo(ctx, post, w, h);
    if (post.dof && post.dof.aperture > 0) applyDof(ctx, post, w, h);
    const hasGlow = Boolean(post.bloom && post.bloom.strength > 0);
    if (hasGlow) bloomGlow(ctx, post, w, h);
    each(ctx, h, ROWS, (y0, y1) => finishRows(post, w, h, hasGlow, y0, y1));
    ctx.sync();
  }

  // ---------------------------------------------------------------- frame
  /** Run one frame on this rank; returns the centre pass's rasterized triangles counted by this rank. */
  function runFrame(job: Mesh3dKernelJobV1, ctx: Mesh3dKernelCtxV1): number {
    const { width, height } = job;
    // Mip chains (level by level; every texture's level k before any level k + 1).
    const depthOf = job.textures.reduce((n, t) => Math.max(n, t.mips.length), 0);
    for (let k = 1; k < depthOf; k++) {
      for (const t of job.textures) if (k < t.mips.length) each(ctx, t.mipHeight[k], ROWS, (a, b) => mipRows(t, k, a, b));
      ctx.sync();
    }
    const count = job.passes.length, multi = count > 1;
    let centreRasterized = 0;
    for (let i = 0; i < count; i++) {
      const pass = job.passes[i];
      if (pass.shadow) shadowPhases(ctx, pass);
      let rasterized = 0;
      each(ctx, height, ROWS, (y0, y1) => {
        paintRows(job, y0, y1);
        for (const d of pass.draws) {
          if (d.yMax < y0 || d.yMin >= y1) continue;
          rasterized += d.kind === 0 ? drawLegacy(job, d, y0, y1) : drawExtended(job, pass, d, y0, y1);
        }
        if (multi) {
          const a = y0 * width, b = y1 * width;
          if (i === job.centre) { job.refDepth!.set(job.depth.subarray(a, b), a); if (job.refPrecise) job.refPrecise.set(job.depthPrecise!.subarray(a, b), a); }
          const sum = job.sum!, hdr = job.hdr!;
          if (i === 0) sum.fill(0, a * 3, b * 3);
          for (let k = a * 3; k < b * 3; k++) sum[k] += hdr[k] / count;
        }
      });
      if (i === job.centre) centreRasterized = rasterized;
      ctx.sync();
    }
    if (job.post) postPhases(ctx, job.post, width, height);
    return centreRasterized;
  }

  return { runFrame, serialCtx, postPhases, blur, gapFill, each };
}
export type Mesh3dKernelV1 = ReturnType<typeof mesh3dKernelFactoryV1>;
