import { BoxGeometry, BufferGeometry, ConeGeometry, CylinderGeometry, ExtrudeGeometry, Float32BufferAttribute, ShapePath, SphereGeometry, TorusGeometry } from "three";
import { parse, type Font } from "opentype.js";
import type { Mesh3dGeometry, Mesh3dScene } from "./mesh3dScene";
import { mesh3dExtrudeShapes, mesh3dFlattenCommands, mesh3dGlyphRun, mesh3dGroupContours, mesh3dPolylineBounds, mesh3dRoundedRectPolyline, mesh3dStarPolyline, type Mesh3dMeshData } from "./mesh3dExtrude";
import { mesh3dBandTextV1, type Mesh3dMaskV1 } from "./mesh3dBandText";
import { mesh3dTextFaceIdV1 } from "./mesh3dTextFaces";
import { MESH3D_SCENE_BUDGET_V1, mesh3dGeometryAtV1, mesh3dGeometryPeakV1, type Mesh3dMaterial, type Mesh3dObject, type Mesh3dTubeSetGeometryV1 } from "./mesh3dScene";
import { mesh3dTubeSetMeshV1, mesh3dTubeTipsMeshV1 } from "./mesh3dTubeSet";

/** `uvUntextured`: some UVs are NaN (faces a uvMode leaves untextured; they shade with the material colour). */
export interface Mesh3dBuffers { positions: Float32Array; normals: Float32Array; uvs: Float32Array; indices: Uint32Array; mask?: Mesh3dMaskV1; uvUntextured?: boolean; }
export function parseMesh3dFont(bytes: ArrayBuffer): Font { return parse(bytes); }
/** Per-object triangle ceiling for the new glyph kinds (each geometry keeps its 60000 ceiling; scenes have MESH3D_MAX_SCENE_TRIANGLES). */
export const MESH3D_TEXT_TRIANGLE_LIMIT = 30000;
/** Geometry cache entries kept (least recently used evicted); at least the per-frame object budget, so a frame never rebuilds its own meshes. */
export const MESH3D_GEOMETRY_CACHE_ENTRIES = 128;
/** Bundled face IDs a scene's text_extrude / band_text objects need; load and verify them before building geometry. */
export function mesh3dSceneTextFaceIdsV1(scene: Mesh3dScene): string[] {
  const ids = new Set<string>();
  for (const segment of scene.segments) for (const object of segment.objects) {
    const g = object.geometry;
    if (g.kind === "text_extrude" || g.kind === "band_text") ids.add(mesh3dTextFaceIdV1(g.font, g.weight));
  }
  return [...ids].sort();
}
function buffersOf(data: Mesh3dMeshData): Mesh3dBuffers {
  return { positions: Float32Array.from(data.positions), normals: Float32Array.from(data.normals), uvs: Float32Array.from(data.uvs), indices: Uint32Array.from(data.indices) };
}
export class Mesh3dGeometryCache {
  private readonly entries = new Map<string, Mesh3dBuffers>();
  /** `fonts`: Noto Sans TC by weight for the legacy `text` kind. `faces`: bundled faces by face ID for text_extrude / band_text. */
  constructor(private readonly fonts: Map<number, Font> = new Map(), private readonly faces: Map<string, Font> = new Map()) {}
  get(spec: Mesh3dGeometry): Mesh3dBuffers {
    if (spec.kind === "tube_set") return this.tube(spec);
    const key = JSON.stringify(spec), cached = this.entries.get(key);
    if (cached) { this.entries.delete(key); this.entries.set(key, cached); return cached; }
    const extended = this.extended(spec);
    if (extended) {
      if (extended.indices.length / 3 > 60000) throw new Error("3D 幾何超出 60000 三角形上限");
      if (this.entries.size >= MESH3D_GEOMETRY_CACHE_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
      this.entries.set(key, extended); return extended;
    }
    let geometry: BufferGeometry;
    if (spec.kind === "box") { geometry = new BoxGeometry(spec.width, spec.height, spec.depth); if (spec.uvMode && spec.uvMode !== "repeat") boxUvMode(geometry, spec.uvMode); }
    else if (spec.kind === "sphere") geometry = new SphereGeometry(spec.radius, spec.segments, Math.max(8, Math.floor(spec.segments / 2)));
    else if (spec.kind === "torus") geometry = new TorusGeometry(spec.radius, spec.tube, spec.tubeSegments ?? 8, spec.segments);
    else if (spec.kind === "cone") geometry = new ConeGeometry(spec.radius, spec.height, spec.segments, 1, false);
    else if (spec.kind === "cylinder") geometry = new CylinderGeometry(spec.radiusTop, spec.radiusBottom, spec.height, spec.segments, 1, spec.openEnded);
    else if (spec.kind === "curved_video") {
      const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
      const rows = Math.max(2, Math.floor(spec.segments / 3));
      for (let y = 0; y <= rows; y++) for (let x = 0; x <= spec.segments; x++) {
        const u = x / spec.segments, v = y / rows, angle = (u - .5) * spec.width / spec.radius;
        positions.push(Math.sin(angle) * spec.radius, (v - .5) * spec.height, (Math.cos(angle) - 1) * spec.radius); uvs.push(u, v);
      }
      for (let y = 0; y < rows; y++) for (let x = 0; x < spec.segments; x++) {
        const a = y * (spec.segments + 1) + x, b = a + 1, c = a + spec.segments + 1, d = c + 1;
        indices.push(a, b, d, a, d, c);
      }
      geometry = new BufferGeometry().setAttribute("position", new Float32BufferAttribute(positions, 3)).setAttribute("uv", new Float32BufferAttribute(uvs, 2));
      geometry.setIndex(indices); geometry.computeVertexNormals();
    } else if (spec.kind === "text") {
      const font = this.fonts.get(spec.fontWeight);
      if (!font) throw new Error(`3D 實體字尚未載入字重 ${spec.fontWeight} 的實際字型`);
      const paths = new ShapePath(), factor = spec.height / font.unitsPerEm;
      let offset = 0;
      for (const character of spec.text) {
        const glyph = font.charToGlyph(character);
        if (glyph.index === 0 && character.trim()) throw new Error(`實體字型缺少「${character}」；不接受替代方框`);
        if (spec.curveSegments !== undefined) {
          // Adaptive: each curve gets as many segments as its bend needs (≤ curveSegments), not a fixed 3.
          for (const contour of mesh3dFlattenCommands(glyph.path.commands as Parameters<typeof mesh3dFlattenCommands>[0], factor, offset, 0, spec.height * .0003, spec.curveSegments)) {
            paths.moveTo(contour[0], contour[1]);
            for (let i = 2; i < contour.length; i += 2) paths.lineTo(contour[i], contour[i + 1]);
            paths.currentPath?.closePath();
          }
          offset += (glyph.advanceWidth ?? font.unitsPerEm) * factor;
          continue;
        }
        for (const command of glyph.path.commands) {
          if (command.type === "M") paths.moveTo(offset + command.x * factor, command.y * factor);
          else if (command.type === "L") paths.lineTo(offset + command.x * factor, command.y * factor);
          else if (command.type === "Q") paths.quadraticCurveTo(offset + command.x1 * factor, command.y1 * factor, offset + command.x * factor, command.y * factor);
          else if (command.type === "C") paths.bezierCurveTo(offset + command.x1 * factor, command.y1 * factor, offset + command.x2 * factor, command.y2 * factor, offset + command.x * factor, command.y * factor);
          else if (command.type === "Z") paths.currentPath?.closePath();
        }
        offset += (glyph.advanceWidth ?? font.unitsPerEm) * factor;
      }
      geometry = new ExtrudeGeometry(paths.toShapes(), { depth: spec.depth, steps: 1, curveSegments: 3, bevelEnabled: spec.bevel > 0, bevelThickness: spec.bevel, bevelSize: spec.bevel, bevelSegments: 1 });
      geometry.computeBoundingBox(); const box = geometry.boundingBox!;
      geometry.translate(-(box.min.x + box.max.x) / 2, -(box.min.y + box.max.y) / 2, -spec.depth / 2);
    } else throw new Error(`未知的 3D 幾何：${(spec as { kind: string }).kind}`);
    const p = geometry.getAttribute("position"), n = geometry.getAttribute("normal"), uv = geometry.getAttribute("uv");
    const indices = geometry.index ? Uint32Array.from(geometry.index.array) : Uint32Array.from({ length: p.count }, (_, i) => i);
    if (indices.length / 3 > 60000) { geometry.dispose(); throw new Error("3D 幾何超出 60000 三角形上限"); }
    const buffers: Mesh3dBuffers = { positions: Float32Array.from(p.array), normals: Float32Array.from(n.array), uvs: uv ? Float32Array.from(uv.array) : new Float32Array(p.count * 2), indices };
    if (spec.kind === "box" && spec.uvMode === "front") buffers.uvUntextured = true;
    geometry.dispose();
    if (this.entries.size >= MESH3D_GEOMETRY_CACHE_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, buffers); return buffers;
  }
  private readonly tubes = new Map<string, Mesh3dBuffers>();
  /**
   * tube_set (2026-10-29): a mesh per growth value, so an animated object makes a new one every frame. They live in their
   * own LRU, bounded by triangles (three frames of the scene budget), so they never evict other geometry. A tube_set
   * may use the whole per-frame budget (MESH3D_SCENE_BUDGET_V1.triangles), not the 60,000 of other kinds.
   */
  private tube(input: Mesh3dTubeSetGeometryV1, role?: string): Mesh3dBuffers {
    // Frames pass a still spec (mesh3dGeometryAtV1). A spec still carrying keyframes (bounds, picking, budgets outside a
    // frame) stands for its largest extent (mesh3dGeometryPeakV1), never for its first frame.
    const spec = mesh3dGeometryPeakV1(input) as Mesh3dTubeSetGeometryV1, key = role === undefined ? JSON.stringify(spec) : `${JSON.stringify(spec)}\n${role}`, cached = this.tubes.get(key);
    if (cached) { this.tubes.delete(key); this.tubes.set(key, cached); return cached; }
    const mesh: Mesh3dBuffers = role === undefined ? mesh3dTubeSetMeshV1(spec, MESH3D_SCENE_BUDGET_V1.triangles) : mesh3dTubeTipsMeshV1(spec, role, MESH3D_SCENE_BUDGET_V1.triangles);
    this.tubes.set(key, mesh);
    let held = [...this.tubes.values()].reduce((n, m) => n + m.indices.length / 3, 0);
    for (const [old, entry] of this.tubes) {
      if (held <= 3 * MESH3D_SCENE_BUDGET_V1.triangles || old === key) break;
      this.tubes.delete(old); held -= entry.indices.length / 3;
    }
    return mesh;
  }
  /** The tips of one colour role of a tube_set (placed and scaled at the spec's growth; cached with the tube meshes). */
  tubeTips(spec: Mesh3dTubeSetGeometryV1, role: string): Mesh3dBuffers { return this.tube(spec, role); }
  private face(font: Parameters<typeof mesh3dTextFaceIdV1>[0], weight: number): { face: Font; id: string } {
    const id = mesh3dTextFaceIdV1(font, weight), face = this.faces.get(id);
    if (!face) throw new Error(`3D 文字尚未載入內建字型 ${id}`);
    return { face, id };
  }
  /** New kinds (2026-10-23); undefined for the original kinds so their construction is untouched. */
  private extended(spec: Mesh3dGeometry): Mesh3dBuffers | undefined {
    if (spec.kind === "star") {
      const data: Mesh3dMeshData = { positions: [], normals: [], uvs: [], indices: [] }, r = spec.outerRadius;
      mesh3dExtrudeShapes([{ outer: mesh3dStarPolyline(spec.points, spec.outerRadius, spec.innerRadius), holes: [] }],
        { depth: spec.depth, bevelSize: spec.bevel, bevelThickness: spec.bevel, bevelSegments: spec.bevelSegments, profile: "round", creaseDegrees: 30, uvFrame: [-r, -r, r, r] }, data);
      return buffersOf(data);
    }
    if (spec.kind === "rounded_box") {
      const data: Mesh3dMeshData = { positions: [], normals: [], uvs: [], indices: [] };
      const outline = mesh3dRoundedRectPolyline(spec.width, spec.height, spec.radius, Math.max(2, spec.segments * 2));
      mesh3dExtrudeShapes([{ outer: outline, holes: [] }], { depth: spec.depth, bevelSize: spec.radius, bevelThickness: spec.radius,
        bevelSegments: spec.segments, profile: "round", creaseDegrees: 30, uvFrame: [-spec.width / 2, -spec.height / 2, spec.width / 2, spec.height / 2], ...(spec.uvMode === "front" ? { uvFrontOnly: true } : {}) }, data);
      return spec.uvMode === "front" ? { ...buffersOf(data), uvUntextured: true } : buffersOf(data);
    }
    if (spec.kind === "text_extrude") {
      const { face, id } = this.face(spec.font, spec.weight);
      const run = mesh3dGlyphRun(face, spec.text, spec.size, spec.tracking, spec.size * .0012, 16, id);
      const all = run.contours.flat(), [x0, y0, x1, y1] = mesh3dPolylineBounds(all);
      if (!all.length) throw new Error("3D 文字沒有可擠出的字形");
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      // Points closer than about a third of the bevel only make insets fold; merging them is invisible.
      const shapes = run.contours.flatMap(glyph => mesh3dGroupContours(glyph.map(poly => poly.map((v, i) => i % 2 ? v - cy : v - cx)), Math.max(spec.size * 1e-4, spec.bevelSize * .35)));
      const data: Mesh3dMeshData = { positions: [], normals: [], uvs: [], indices: [] };
      mesh3dExtrudeShapes(shapes, { depth: spec.depth, bevelSize: spec.bevelSize, bevelThickness: spec.bevelThickness, bevelSegments: spec.bevelSegments,
        profile: spec.bevelProfile ?? "round", creaseDegrees: 38, uvFrame: [x0 - cx, y0 - cy, x1 - cx, y1 - cy] }, data);
      if (data.indices.length / 3 > MESH3D_TEXT_TRIANGLE_LIMIT) throw new Error(`3D 擠出文字超過 ${MESH3D_TEXT_TRIANGLE_LIMIT} 三角形；請減少字數或倒角段數`);
      return buffersOf(data);
    }
    if (spec.kind === "band_text") {
      const { face, id } = this.face(spec.font, spec.weight);
      const { data, mask } = mesh3dBandTextV1(face, spec, id);
      return { ...buffersOf(data), mask };
    }
    return undefined;
  }
}
/** A tube_set tip draw's material: the object's lighting (unlit, specular, roughness, reflection, edge light, emission, shadow flags, sides) in the role's colour, without the tube's colour sources (clip, stripes, gradient, grid, wireframe). */
export function mesh3dTubeTipMaterialV1(material: Mesh3dMaterial, color: string): Mesh3dMaterial {
  const { clipId: _clip, texture: _texture, stripes: _stripes, gradient: _gradient, grid: _grid, gridStyle: _gridStyle, wireframe: _wireframe, ...lighting } = material;
  return { ...lighting, color, ...(material.emissive ? { emissive: { ...material.emissive, color } } : {}) };
}
/**
 * The draws of a segment's objects at a segment-local time, in object order: each object's geometry at that time
 * (mesh3dGeometryAtV1), and after a tube_set one draw per tip colour role (sorted) with mesh3dTubeTipMaterialV1. A
 * tube_set or role with nothing shown yet is not drawn; every other kind is exactly one draw of its own object.
 */
export function mesh3dObjectDrawsV1(objects: readonly Mesh3dObject[], time: number, cache: Mesh3dGeometryCache): { object: Mesh3dObject; time: number; mesh: Mesh3dBuffers }[] {
  return objects.flatMap(object => {
    if (object.geometry.kind !== "tube_set") return [{ object, time, mesh: cache.get(object.geometry) }];
    const geometry = mesh3dGeometryAtV1(object, time) as Mesh3dTubeSetGeometryV1, tube = cache.get(geometry);
    const draws = tube.indices.length ? [{ object, time, mesh: tube }] : [];
    for (const role of Object.keys(geometry.tipColors ?? {}).sort()) {
      const mesh = cache.tubeTips(geometry, role);
      if (mesh.indices.length) draws.push({ object: { ...object, id: `${object.id}#tip:${role}`, material: mesh3dTubeTipMaterialV1(object.material, geometry.tipColors![role]) }, time, mesh });
    }
    return draws;
  });
}
/** Draws a segment's objects make at most in a frame (one per object, plus the tip colour roles a tube_set uses). */
export function mesh3dObjectDrawCountV1(objects: readonly Mesh3dObject[]): number {
  return objects.reduce((n, object) => n + 1 + (object.geometry.kind === "tube_set" ? new Set((object.geometry.tips ?? []).map(tip => tip.colorRole)).size : 0), 0);
}
/**
 * Box UV layouts (three's faces are +x, −x, +y, −y, +z, −z, four vertices each):
 * "front" keeps +z and marks the other faces untextured (NaN); "atlas" maps face f to
 * cell (f mod 3, ⌊f / 3⌋) of a 3×2 grid, row 0 at the top of the image.
 */
function boxUvMode(geometry: BufferGeometry, mode: "front" | "atlas"): void {
  const uv = geometry.getAttribute("uv");
  for (let i = 0; i < uv.count; i++) {
    const face = Math.floor(i / 4), u = uv.getX(i), v = uv.getY(i);
    if (mode === "front") { if (face !== 4) uv.setXY(i, NaN, NaN); }
    else { const column = face % 3, row = Math.floor(face / 3); uv.setXY(i, (column + u) / 3, (1 - row) * .5 + v * .5); }
  }
}
