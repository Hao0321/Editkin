import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Mesh3dGeometryCache, mesh3dObjectDrawCountV1, mesh3dObjectDrawsV1, mesh3dTubeTipMaterialV1 } from "./mesh3dGeometry";
import { Mesh3dWorkerPoolV1 } from "./mesh3dParallel";
import { renderMesh3dFrame, type Mesh3dFrame } from "./mesh3dRasterizer";
import { MESH3D_SCENE_BUDGET_V1, mesh3dGeometryAtV1, mesh3dGeometryPeakV1, mesh3dGeometrySchema, mesh3dSceneSchema, type Mesh3dObject, type Mesh3dScene, type Mesh3dTubeSetGeometryV1 } from "./mesh3dScene";
import { mesh3dTubeCapRingsV1, mesh3dTubeSetCountV1, mesh3dTubeSetMeshV1, mesh3dTubeSkeletonsV1, mesh3dTubeTipTrianglesV1, mesh3dTubeTipsMeshV1, mesh3dTubeWindowV1 } from "./mesh3dTubeSet";

type V = [number, number, number];
type Tube = Mesh3dTubeSetGeometryV1;
const tube = (input: object): Tube => mesh3dGeometrySchema.parse({ kind: "tube_set", ...input }) as Tube;
const BUDGET = MESH3D_SCENE_BUDGET_V1.triangles;
const sha = (bytes: ArrayBufferView) => createHash("sha256").update(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)).digest("hex");

/** A small deterministic L-system-like tree: trunk and two generations, tapering, staged by growthSpan. */
function tree(depth = 2): Tube["polylines"] {
  const lines: Tube["polylines"] = [];
  const grow = (start: V, dir: V, length: number, radius: number, level: number, span: [number, number]) => {
    const points: V[] = [], radii: number[] = [];
    for (let i = 0; i <= 3; i++) {
      const t = i / 3, wob = Math.sin(t * 3 + level) * .04 * length;
      points.push([start[0] + dir[0] * length * t + wob, start[1] + dir[1] * length * t, start[2] + dir[2] * length * t - wob]);
      radii.push(radius * (1 - .45 * t));
    }
    lines.push({ points, radius: radii, growthSpan: span });
    if (level === 0) return;
    for (const [yaw, pitch] of [[0, 34], [150, 30]]) {
      const y = yaw * Math.PI / 180 + level, p = pitch * Math.PI / 180;
      const d: V = [Math.sin(p) * Math.cos(y) + dir[0] * Math.cos(p), Math.cos(p) * dir[1], Math.sin(p) * Math.sin(y) + dir[2] * Math.cos(p)], l = Math.hypot(...d);
      grow(points[3], [d[0] / l, d[1] / l, d[2] / l], length * .7, radius * .55, level - 1, [span[1], Math.min(1, span[1] + .3)]);
    }
  };
  grow([0, -1.1, 0], [0, 1, 0], 1, .09, depth, [0, .4]);
  return lines;
}
const helix: V[] = Array.from({ length: 61 }, (_, i) => { const a = i / 60 * Math.PI * 4; return [Math.cos(a) * .7, -1 + i / 30, Math.sin(a) * .7]; });
const object = (geometry: object, material: object = {}): Mesh3dObject => ({ id: "t", name: "t", geometry: mesh3dGeometrySchema.parse(geometry),
  material: { color: "#E8A0C8", unlit: false, ...material }, pose: { position: [0, 0, 0], rotationDegrees: [0, 0, 0], scale: [1, 1, 1] }, keyframes: [] }) as Mesh3dObject;
const scene = (objects: Mesh3dObject[], extra: object = {}): Mesh3dScene => mesh3dSceneSchema.parse({ schema: "editkin.mesh-scene/v1", enabled: true,
  background: { color: "#101828", gridColor: "#3050A0", spacing: 40, grid: false }, light: { direction: [-.5, .9, .7], ambient: .35, intensity: .85 },
  segments: [{ id: "s", name: "s", timelineStart: 0, duration: 2, camera: { position: [0, .2, 3.6], target: [0, 0, 0], verticalFovDegrees: 50, near: .1, far: 30 }, cameraKeyframes: [], objects }], ...extra });
const blossomTips = (lines: Tube["polylines"]) => lines.flatMap((line, i) => i === 0 ? [] : [
  { polylineIndex: i, at: "end" as const, mesh: (i % 2 ? "petal" : "star") as "petal" | "star", scale: .08, colorRole: i % 2 ? "blossom" : "accent", revealAt: line.growthSpan![1] },
  { polylineIndex: i, at: .5, mesh: "leaf" as const, scale: .1, colorRole: "leaf", tilt: 55, spin: (90 * i) % 360, revealAt: line.growthSpan![0] + .05 }]);
const tipColors = { blossom: "#FFFFFF", accent: "#FFC23A", leaf: "#4FB46A" };
function bbox(positions: Float32Array) {
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) { box[k] = Math.min(box[k], positions[i + k]); box[k + 3] = Math.max(box[k + 3], positions[i + k]); }
  return box;
}

describe("tube_set geometry", () => {
  it("emits exactly the counted vertices and triangles, all finite, unit normals and in-range indices", () => {
    for (const [name, spec] of [["tree", tube({ polylines: tree(), tips: blossomTips(tree()), tipColors })], ["helix", tube({ polylines: [{ points: helix, radius: .08 }], radialSegments: 12 })],
      ["flat caps", tube({ polylines: [{ points: helix, radius: .08 }], caps: "flat", radialSegments: 5 })], ["window", tube({ polylines: [{ points: helix, radius: .08, reveal: [.25, .6] }] })]] as const) {
      const counts = mesh3dTubeSetCountV1(spec), meshes = [mesh3dTubeSetMeshV1(spec, BUDGET), ...Object.keys(counts.tips).map(role => mesh3dTubeTipsMeshV1(spec, role, BUDGET))];
      expect(meshes[0].positions.length / 3, name).toBe(counts.tube.vertices);
      expect(meshes[0].indices.length / 3, name).toBe(counts.tube.triangles);
      expect(meshes.reduce((n, m) => n + m.indices.length / 3, 0), name).toBe(counts.triangles);
      for (const mesh of meshes) {
        expect([...mesh.positions, ...mesh.normals, ...mesh.uvs].every(Number.isFinite), name).toBe(true);
        for (let i = 0; i < mesh.normals.length; i += 3) expect(Math.abs(Math.hypot(mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2]) - 1), name).toBeLessThan(1e-5);
        expect(Math.max(...mesh.indices), name).toBeLessThan(mesh.positions.length / 3);
      }
    }
  });

  it("has the closed-form count: two rings and two caps for a straight segment, per radial segments and cap style", () => {
    for (const radial of [3, 8, 12, 32]) {
      const c = mesh3dTubeCapRingsV1(radial), straight = { polylines: [{ points: [[0, 0, 0], [0, 1, 0]], radius: .1 }], radialSegments: radial };
      expect(mesh3dTubeSetCountV1(tube(straight)).triangles).toBe(2 * radial + 2 * (2 * c - 1) * radial);
      expect(mesh3dTubeSetCountV1(tube({ ...straight, caps: "flat" })).triangles).toBe(2 * radial + 2 * radial);
    }
  });

  it("keeps a twist-free frame on straight runs and turns it only about the bend axis through a sharp bend", () => {
    // Straight run up, a 150° bend in a tilted plane, another straight run (with a collinear vertex in it).
    const b: V = [.5 / Math.SQRT2, -Math.sqrt(3) / 2, .5 / Math.SQRT2];
    const [sk] = mesh3dTubeSkeletonsV1(tube({ polylines: [{ points: [[0, -1, 0], [0, 0, 0], b, b.map(v => 2 * v) as V], radius: .1 }] }));
    // Bend axis k = a × b; the start frame normal has a component along it, which a minimal rotation about k keeps.
    const kx = b[2], kz = -b[0], kl = Math.hypot(kx, kz), along = (k: number) => (sk.n[k * 3] * kx + sk.n[k * 3 + 2] * kz) / kl;
    expect(Math.abs(along(0))).toBeGreaterThan(.5);
    for (let k = 0; k < sk.count; k++) {
      const t = [sk.t[k * 3], sk.t[k * 3 + 1], sk.t[k * 3 + 2]], n = [sk.n[k * 3], sk.n[k * 3 + 1], sk.n[k * 3 + 2]];
      expect(Math.abs(t[0] * n[0] + t[1] * n[1] + t[2] * n[2])).toBeLessThan(1e-12);
      expect(Math.abs(Math.hypot(...n) - 1)).toBeLessThan(1e-12);
      expect(Math.abs(along(k) - along(0))).toBeLessThan(1e-9);
    }
    // Straight runs: every sample shares the frame of its neighbour exactly (no twist accumulates).
    expect(sk.count).toBeGreaterThan(6);
    const dot = (a: number, b: number) => sk.n[a * 3] * sk.n[b * 3] + sk.n[a * 3 + 1] * sk.n[b * 3 + 1] + sk.n[a * 3 + 2] * sk.n[b * 3 + 2];
    expect(dot(0, 1)).toBeCloseTo(1, 12); expect(dot(sk.count - 2, sk.count - 1)).toBeCloseTo(1, 12);
    // The fillet keeps the centerline smooth: consecutive tangents turn by at most 30°.
    for (let k = 0; k + 1 < sk.count; k++) {
      const d = sk.t[k * 3] * sk.t[k * 3 + 3] + sk.t[k * 3 + 1] * sk.t[k * 3 + 4] + sk.t[k * 3 + 2] * sk.t[k * 3 + 5];
      expect(d).toBeGreaterThanOrEqual(Math.cos(Math.PI / 6) - 1e-12);
    }
  });

  it("tapers by per-vertex radius, with normals tilted along the taper", () => {
    const spec = tube({ polylines: [{ points: [[0, 0, 0], [0, 1, 0], [0, 2, 0]], radius: [.2, .11, .02] }], radialSegments: 8, caps: "flat" });
    const mesh = mesh3dTubeSetMeshV1(spec, BUDGET), radial = 8, ringSize = radial + 1;
    // Side rings follow the flat start cap (centre + ring): radius at y = 0, 1, 2 is 0.2, 0.11, 0.02.
    const start = 1 + ringSize, radius = (ring: number) => Math.hypot(mesh.positions[(start + ring * ringSize) * 3], mesh.positions[(start + ring * ringSize) * 3 + 2]);
    expect([radius(0), radius(1), radius(2)].map(r => Math.round(r * 1e5) / 1e5)).toEqual([.2, .11, .02]);
    // Radius falls along +y, so side normals lean toward +y.
    expect(mesh.normals[start * 3 + 1]).toBeGreaterThan(.05);
  });

  it("refuses over-budget input before allocating, counting instanced tips, and counts a draw per tip colour role", () => {
    const heavy = tube({ polylines: Array.from({ length: 40 }, (_, i) => ({ points: Array.from({ length: 200 }, (_, k) => [i * .05, k * .01, 0] as V), radius: .01 })), radialSegments: 32 });
    expect(mesh3dTubeSetCountV1(heavy).triangles).toBeGreaterThan(BUDGET);
    expect(() => mesh3dTubeSetMeshV1(heavy, BUDGET)).toThrow("MESH_TUBE_SET_TRIANGLE_BUDGET");
    expect(() => new Mesh3dGeometryCache().get(heavy)).toThrow("MESH_TUBE_SET_TRIANGLE_BUDGET");
    // A tiny tube with 4096 sphere buds: the tips alone exceed the budget.
    const buds = tube({ polylines: [{ points: [[0, 0, 0], [0, 1, 0]], radius: .05 }], tips: Array.from({ length: 4096 }, (_, i) => ({ polylineIndex: 0, at: i / 4095, mesh: "sphere", scale: .02, colorRole: "bud" })), tipColors: { bud: "#FFFFFF" } });
    expect(mesh3dTubeSetCountV1(buds).tube.triangles).toBeLessThan(200);
    expect(mesh3dTubeSetCountV1(buds).triangles).toBe(mesh3dTubeSetCountV1(buds).tube.triangles + 4096 * mesh3dTubeTipTrianglesV1("sphere"));
    expect(() => new Mesh3dGeometryCache().get(buds)).toThrow("MESH_TUBE_SET_TRIANGLE_BUDGET");
    const tips = object({ kind: "tube_set", polylines: tree(), tips: blossomTips(tree()), tipColors });
    expect(mesh3dObjectDrawCountV1([tips, object({ kind: "box", width: 1, height: 1, depth: 1 })])).toBe(1 + 3 + 1);
  });

  it("refuses inconsistent specs in the schema", () => {
    const line = { points: [[0, 0, 0], [0, 1, 0]], radius: .1 };
    expect(() => tube({ polylines: [{ ...line, points: [[0, 0, 0], [0, 0, 0]] }] })).toThrow("相鄰點不可重合");
    expect(() => tube({ polylines: [{ ...line, radius: [.1] }] })).toThrow("逐點半徑");
    expect(() => tube({ polylines: [{ ...line, closed: true }] })).toThrow();
    expect(() => tube({ polylines: [{ ...line, reveal: [.6, .2] }] })).toThrow();
    expect(() => tube({ polylines: [line], tips: [{ polylineIndex: 1, at: "end", mesh: "petal", scale: .1, colorRole: "a" }], tipColors: { a: "#FFFFFF" } })).toThrow("不存在的管線");
    expect(() => tube({ polylines: [line], tips: [{ polylineIndex: 0, at: "end", mesh: "petal", scale: .1, colorRole: "a" }] })).toThrow("tipColors");
    expect(() => tube({ polylines: [line], tips: [{ polylineIndex: 0, at: "end", mesh: "cube", scale: .1, colorRole: "a" }], tipColors: { a: "#FFFFFF" } })).toThrow();
  });
});

describe("tube_set reveal and tips over time", () => {
  it("grows monotonically from nothing, with no popping (each step moves the mesh by about the step)", () => {
    const steps = 200;
    for (const [name, base] of [["tree", { polylines: tree() }], ["helix", { polylines: [{ points: helix, radius: .08 }] }], ["window", { polylines: [{ points: helix, radius: .08, reveal: [.2, .9] }] }]] as const) {
      const spec = tube(base), skeletons = mesh3dTubeSkeletonsV1(spec);
      // The most arc length any polyline adds in one growth step (its window length over its growth span).
      const stepArc = Math.max(...spec.polylines.map((p, i) => {
        const window = mesh3dTubeWindowV1(p, 1)!, span = p.growthSpan ? p.growthSpan[1] - p.growthSpan[0] : 1;
        return skeletons[i].length * (window[1] - window[0]) / span / steps;
      }));
      let previous: { triangles: number; box: number[] } | undefined;
      for (let step = 0; step <= steps; step++) {
        const growth = step / steps, at = tube({ ...base, growth }), counts = mesh3dTubeSetCountV1(at);
        if (step === 0) { expect(counts.triangles, name).toBe(0); continue; }
        const box = bbox(mesh3dTubeSetMeshV1(at, BUDGET).positions);
        if (previous) {
          expect(counts.triangles, `${name} ${growth}`).toBeGreaterThanOrEqual(previous.triangles);
          // The box only grows (up to the faceted tip dome turning with a curve), by at most the arc added plus the thickening.
          box.forEach((v, k) => expect(k < 3 ? previous!.box[k] - v : v - previous!.box[k], `${name} ${growth} axis ${k}`).toBeGreaterThanOrEqual(-1e-3));
          expect(Math.max(...box.map((v, k) => Math.abs(v - previous!.box[k]))), `${name} ${growth}`).toBeLessThan(2 * stepArc + 1e-6);
        } else expect(Math.max(box[3] - box[0], box[4] - box[1], box[5] - box[2]), `${name}: the first step is tiny`).toBeLessThan(3 * stepArc);
        previous = { triangles: counts.triangles, box };
      }
    }
  });

  it("samples animated reveal windows and growth like pose keyframes, and the peak covers every frame", () => {
    const geometry = { kind: "tube_set", growth: 0, growthKeyframes: [{ time: 1, growth: 1, easing: "linear" }],
      polylines: [{ points: helix, radius: .08, reveal: [0, 0], revealKeyframes: [{ time: .5, reveal: [0, 1], easing: "smooth" }, { time: 2, reveal: [.6, 1], easing: "linear" }] }] };
    const animated = object(geometry), peak = mesh3dGeometryPeakV1(animated.geometry) as Tube, peakTriangles = mesh3dTubeSetCountV1(peak).triangles;
    expect(peak.growth).toBe(1); expect(peak.polylines[0].reveal).toEqual([0, 1]);
    let previousEnd = 0;
    for (let frame = 0; frame <= 60; frame++) {
      const time = frame / 30, still = mesh3dGeometryAtV1(animated, time) as Tube;
      expect(still.growthKeyframes).toBeUndefined(); expect(still.polylines[0].revealKeyframes).toBeUndefined();
      expect(mesh3dTubeSetCountV1(still).triangles).toBeLessThanOrEqual(peakTriangles);
      const window = mesh3dTubeWindowV1(still.polylines[0], still.growth!);
      if (time <= 1) { expect((window?.[1] ?? 0) + 1e-12).toBeGreaterThanOrEqual(previousEnd); previousEnd = window?.[1] ?? 0; }
    }
    expect(mesh3dTubeWindowV1((mesh3dGeometryAtV1(animated, 2) as Tube).polylines[0], 1)).toEqual([.6, 1]);
    // A still object, and every other kind, is returned as is (same object).
    const still = object({ kind: "tube_set", polylines: [{ points: helix, radius: .08 }] });
    expect(mesh3dGeometryAtV1(still, .7)).toBe(still.geometry);
    // Outside a frame (bounds, picking, budgets) a spec still carrying keyframes is its largest extent, not its first frame.
    const full = mesh3dTubeSetMeshV1(tube({ polylines: [{ points: helix, radius: .08 }] }), BUDGET);
    expect(sha(new Mesh3dGeometryCache().get(animated.geometry).positions)).toBe(sha(full.positions));
  });

  it("shows a tip only after its revealAt and once its anchor is drawn, growing in without popping", () => {
    const line = { points: [[0, 0, 0], [0, 1, 0]] as V[], radius: .05, growthSpan: [0, .5] as [number, number] };
    const base = { polylines: [line], tips: [{ polylineIndex: 0, at: "end" as const, mesh: "petal" as const, scale: .2, colorRole: "a", revealAt: .6 },
      { polylineIndex: 0, at: .3, mesh: "leaf" as const, scale: .2, colorRole: "a", revealAt: .1 }], tipColors: { a: "#FFFFFF" } };
    let previousSize = 0;
    for (let step = 0; step <= 100; step++) {
      const growth = step / 100, spec = tube({ ...base, growth }), tips = mesh3dTubeSetCountV1(spec).tips.a?.triangles ?? 0;
      const petal = mesh3dTubeTipTrianglesV1("petal"), leaf = mesh3dTubeTipTrianglesV1("leaf");
      // The leaf's anchor (0.3 of the branch) is drawn at growth 0.15; its revealAt is 0.1. The petal waits for 0.6.
      expect(tips, `growth ${growth}`).toBe((growth >= .15 ? leaf : 0) + (growth > .6 ? petal : 0));
      if (growth > .6) {
        // It grows in over 0.05 of growth (smoothstep), then keeps its size; no step jumps by more than a fraction of it.
        const mesh = mesh3dTubeTipsMeshV1(tube({ ...base, growth, tips: [base.tips[0]] }), "a", BUDGET), box = bbox(mesh.positions), size = box[3] - box[0];
        if (growth <= .65) expect(size, `growth ${growth}`).toBeGreaterThan(previousSize); else expect(size).toBeCloseTo(previousSize, 9);
        expect(size - previousSize, `growth ${growth}`).toBeLessThan(.2 * 2 * .5);
        previousSize = size;
      }
    }
    expect(previousSize).toBeGreaterThan(.3);
  });

  it("draws tips with the object's lighting in their role colour, one draw per role, nothing for hidden tips", () => {
    const material = { color: "#5A3020", unlit: false, roughness: .4, specular: { strength: .5, shininess: 40 }, emissive: { color: "#FF0000", strength: .3 }, gradient: { colors: ["#000000", "#FFFFFF"], axis: "y" } };
    expect(mesh3dTubeTipMaterialV1(material as Mesh3dObject["material"], "#FFFFFF")).toEqual({ color: "#FFFFFF", unlit: false, roughness: .4, specular: { strength: .5, shininess: 40 }, emissive: { color: "#FFFFFF", strength: .3 } });
    const cache = new Mesh3dGeometryCache(), lines = tree(), objects = [object({ kind: "tube_set", polylines: lines, tips: blossomTips(lines), tipColors, growth: 1 })];
    expect(mesh3dObjectDrawsV1(objects, 0, cache).map(d => d.object.id)).toEqual(["t", "t#tip:accent", "t#tip:blossom", "t#tip:leaf"]);
    expect(mesh3dObjectDrawsV1([object({ kind: "tube_set", polylines: lines, tips: blossomTips(lines), tipColors, growth: .1 })], 0, cache).map(d => d.object.id)).toEqual(["t"]);
    expect(mesh3dObjectDrawsV1([object({ kind: "tube_set", polylines: lines, growth: 0 })], 0, cache)).toEqual([]);
  });
});

describe("tube_set renders", () => {
  const lines = tree();
  const scenes = {
    tree: scene([object({ kind: "tube_set", polylines: lines, tips: blossomTips(lines), tipColors })]),
    "tree at half growth": scene([object({ kind: "tube_set", polylines: lines, tips: blossomTips(lines), tipColors, growth: .55 })]),
    helix: scene([object({ kind: "tube_set", polylines: [{ points: helix, radius: .08 }], radialSegments: 12 }, { specular: { strength: 1, shininess: 60 } })]),
  };
  it.each(Object.keys(scenes))("matches the golden frame: %s", name => {
    const frame = renderMesh3dFrame(scenes[name as keyof typeof scenes], .5, 96, 96, new Mesh3dGeometryCache());
    expect(frame.triangleCount).toBeGreaterThan(100);
    expect({ rgba: sha(frame.rgba), depth: sha(frame.depth) }).toEqual(GOLDEN[name as keyof typeof GOLDEN]);
  });

  // Shadows, AO, GGX roughness, emission + bloom, an animated growth and reveal window, motion blur: same bytes on any thread count.
  const lit = scene([
    object({ kind: "tube_set", polylines: lines, tips: blossomTips(lines), tipColors, growth: 0, growthKeyframes: [{ time: 2, growth: 1, easing: "smooth" }] }, { roughness: .35, specular: { strength: .6, shininess: 40 } }),
    { ...object({ kind: "tube_set", polylines: [{ points: helix, radius: .05, reveal: [0, .1], revealKeyframes: [{ time: 2, reveal: [.5, 1], easing: "linear" }] }], radialSegments: 10 },
      { emissive: { color: "#FF66AA", strength: 1.2 } }), id: "h" },
    { ...object({ kind: "box", width: 4, height: .05, depth: 4 }, { color: "#303848" }), id: "floor", pose: { position: [0, -1.15, 0], rotationDegrees: [0, 0, 0], scale: [1, 1, 1] } },
  ], { light: { direction: [-.5, .9, .7], ambient: .3, intensity: .9, size: 6, shadow: { strength: .7, softness: 2, mapSize: 512 } },
    post: { ao: { strength: .6, radius: .3 }, bloom: { threshold: .7, strength: .6, radius: .05 }, motionBlur: { shutterSeconds: .04, samples: 3 } } });
  const pools = new Map<number, Mesh3dWorkerPoolV1>();
  afterAll(async () => { await Promise.all([...pools.values()].map(pool => pool.close())); });
  it("renders byte-identical frames on the calling thread and on 1, 3 and the default number of workers", async () => {
    const bytes = (f: Mesh3dFrame) => [sha(f.rgba), sha(f.depth), f.triangleCount, f.rasterizedTriangles];
    for (const time of [.4, 1.1, 1.9]) {
      const reference = bytes(renderMesh3dFrame(lit, time, 120, 160, new Mesh3dGeometryCache()));
      for (const threads of [1, 3, undefined]) {
        const key = threads ?? 0; if (!pools.has(key)) pools.set(key, new Mesh3dWorkerPoolV1(threads === undefined ? {} : { threads }));
        expect(bytes(await pools.get(key)!.render(lit, time, 120, 160, new Mesh3dGeometryCache())), `${threads ?? "default"} threads at ${time}`).toEqual(reference);
      }
    }
  }, 120_000);
});

/** Pinned 2026-10-29 from the reviewed renders (96×96 at t = 0.5 s; tree with petal/star/leaf tips, its 0.55 growth, a 12-segment helix). */
const GOLDEN = {
  tree: { rgba: "85277d0f9df0ea9118865c9d78012ca490750ec822c197a3653384cf16501ea2", depth: "8f98e814fd51a3e2b29f17f28a5048f4c138aa2e4ac8a1325eb7cb29ec7b43b8" },
  "tree at half growth": { rgba: "7366b489e633febc49b00a8add997f780f0a7b4bf806db2a91b471841defcbda", depth: "8296236d9c1610b18d46c036d2b1c7b97c295685b2e939d87a7b9b66a537a2fe" },
  helix: { rgba: "1bb47965528d1160b509260fcf1df3c8c5f57c7ba290d97f1de5a4c4d32e77b5", depth: "1860bf9118ebae2f67760d5a946c3f65ab1199ed32fc7c086930710a559f9653" },
};
