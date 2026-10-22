import { BoxGeometry, BufferGeometry, ExtrudeGeometry, Float32BufferAttribute, ShapePath, SphereGeometry, TorusGeometry } from "three";
import { parse, type Font } from "opentype.js";
import type { Mesh3dGeometry } from "./mesh3dScene";

export interface Mesh3dBuffers { positions: Float32Array; normals: Float32Array; uvs: Float32Array; indices: Uint32Array; }
export function parseMesh3dFont(bytes: ArrayBuffer): Font { return parse(bytes); }
export class Mesh3dGeometryCache {
  private readonly entries = new Map<string, Mesh3dBuffers>();
  constructor(private readonly fonts: Map<number, Font> = new Map()) {}
  get(spec: Mesh3dGeometry): Mesh3dBuffers {
    const key = JSON.stringify(spec), cached = this.entries.get(key);
    if (cached) { this.entries.delete(key); this.entries.set(key, cached); return cached; }
    let geometry: BufferGeometry;
    if (spec.kind === "box") geometry = new BoxGeometry(spec.width, spec.height, spec.depth);
    else if (spec.kind === "sphere") geometry = new SphereGeometry(spec.radius, spec.segments, Math.max(8, Math.floor(spec.segments / 2)));
    else if (spec.kind === "torus") geometry = new TorusGeometry(spec.radius, spec.tube, 8, spec.segments);
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
    } else {
      const font = this.fonts.get(spec.fontWeight);
      if (!font) throw new Error(`3D 實體字尚未載入字重 ${spec.fontWeight} 的實際字型`);
      const paths = new ShapePath(), factor = spec.height / font.unitsPerEm;
      let offset = 0;
      for (const character of spec.text) {
        const glyph = font.charToGlyph(character);
        if (glyph.index === 0 && character.trim()) throw new Error(`實體字型缺少「${character}」；不接受替代方框`);
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
    }
    const p = geometry.getAttribute("position"), n = geometry.getAttribute("normal"), uv = geometry.getAttribute("uv");
    const indices = geometry.index ? Uint32Array.from(geometry.index.array) : Uint32Array.from({ length: p.count }, (_, i) => i);
    if (indices.length / 3 > 60000) { geometry.dispose(); throw new Error("3D 幾何超出 60000 三角形上限"); }
    const buffers = { positions: Float32Array.from(p.array), normals: Float32Array.from(n.array), uvs: uv ? Float32Array.from(uv.array) : new Float32Array(p.count * 2), indices };
    geometry.dispose();
    if (this.entries.size >= 32) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, buffers); return buffers;
  }
}
