import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { linearToAcescct, linearToDisplay } from "../color/gradeV2Color";
import { DEFAULT_SCENE_25D } from "../domain/types";
import { buildGpuEngineVideoPreviewGraph } from "./gpuCompositor";
import { timelineTransitionLinearShaderV1, timelineTransitionMixV1, type TransitionRgbaV1 } from "./timelineTransitionMixV1";
import { timelineTransitionMatteMixV1, timelineTransitionMatteShaderV1, timelineTransitionMatteStreamV1 } from "./timelineTransitionMatteV1";
import { TIMELINE_TRANSITION_NATIVE_MATTE_DECLINED, timelineTransitionNativeDeclineV1 } from "./timelineTransitionNativeV1";
import { fixtureTransitionField, motionLibraryFixtureProject } from "../domain/motionLibraryV1.fixture";
import { applyCommand } from "../domain/commands";

const f = Math.fround;
/** f32 evaluator of transition_matte_pixel_v1 exactly as written in WGSL (each operation rounded to binary32). */
function wgslMatteF32(a: TransitionRgbaV1, b: TransitionRgbaV1, matte: number, overlay: TransitionRgbaV1 | undefined): number[] {
  const A = a.map(f), B = b.map(f), m = Math.min(1, Math.max(0, f(matte)));
  const wa = f(f(1 - m) * A[3]), wb = f(m * B[3]), mixAlpha = f(wa + wb);
  let mixed = [0, 0, 0, 0];
  if (m === 0) { if (A[3] !== 0) mixed = A; }
  else if (m === 1) { if (B[3] !== 0) mixed = B; }
  else if (mixAlpha !== 0) mixed = [0, 1, 2].map(c => f(f(f(wa * A[c]) + f(wb * B[c])) / mixAlpha)).concat(mixAlpha);
  if (!overlay) return mixed;
  const O = overlay.map(f);
  if (O[3] === 0) return mixed;
  if (O[3] === 1) return O;
  const alpha = f(O[3] + f(mixed[3] * f(1 - O[3])));
  return [0, 1, 2].map(c => f(f(f(O[3] * O[c]) + f(f(mixed[3] * f(1 - O[3])) * mixed[c])) / alpha)).concat(alpha);
}

function* fixtures(): Generator<{ a: TransitionRgbaV1; b: TransitionRgbaV1; m: number; o?: TransitionRgbaV1 }> {
  const alphas = [0, 1 / 65535, .25, .5, .999, 1], mattes = [0, 1 / 65535, .1, .5, .75, 65534 / 65535, 1];
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (const aa of alphas) for (const ab of alphas) for (const m of mattes) for (const oa of [undefined, 0, .3, 1]) {
    const colour = () => [random() * 1.2, random(), random() * 4] as const;
    const a: TransitionRgbaV1 = [...colour(), aa], b: TransitionRgbaV1 = [...colour(), ab];
    yield { a, b, m, ...(oa === undefined ? {} : { o: [...colour(), oa] as TransitionRgbaV1 }) };
  }
}

describe("matte kernel CPU reference", () => {
  it("is exact A at m=0 and exact B at m=1 per pixel, and transparent where both are", () => {
    const a: TransitionRgbaV1 = [4, -.01, .3, .25], b: TransitionRgbaV1 = [.2, 12, .7, .75];
    for (const space of ["linear", "acescct", "rec709_display"] as const) {
      expect(timelineTransitionMatteMixV1(a, b, 0, undefined, space)).toEqual(a);
      expect(timelineTransitionMatteMixV1(a, b, 1, undefined, space)).toEqual(b);
      expect(timelineTransitionMatteMixV1(a, b, .5, [9, 9, 9, 0], space)).toEqual(timelineTransitionMatteMixV1(a, b, .5, undefined, space));
      expect(timelineTransitionMatteMixV1(a, b, .5, [.1, .2, .3, 1], space)).toEqual([.1, .2, .3, 1]);
    }
    expect(timelineTransitionMatteMixV1([1, 1, 1, 0], [0, 1, 0, 0], .5, undefined)).toEqual([0, 0, 0, 0]);
  });
  it("equals the dissolve kernel where the matte is uniform", () => {
    for (const space of ["linear", "acescct", "rec709_display"] as const) {
      const encode = space === "acescct" ? linearToAcescct : space === "rec709_display" ? linearToDisplay : (v: number) => v;
      const a: TransitionRgbaV1 = [encode(.1), encode(.4), encode(.9), .6], b: TransitionRgbaV1 = [encode(.7), encode(.2), encode(.05), .9];
      for (const u of [.125, .5, .875]) {
        const matte = timelineTransitionMatteMixV1(a, b, u, undefined, space), dissolve = timelineTransitionMixV1(a, b, u, "dissolve", space);
        matte.forEach((value, index) => expect(value).toBeCloseTo(dissolve[index], 13));
      }
    }
  });
  it("composites the overlay over the mix in linear light", () => {
    const encode = linearToDisplay, result = timelineTransitionMatteMixV1([encode(.2), encode(.2), encode(.2), 1], [encode(.6), encode(.6), encode(.6), 1], .5,
      [encode(1), encode(0), encode(0), .5], "rec709_display");
    expect(result[3]).toBe(1);
    expect(result[0]).toBeCloseTo(encode(.5 * 1 + .5 * .4), 12);
    expect(result[1]).toBeCloseTo(encode(.5 * .4), 12);
  });
  it("refuses malformed pixels and the scalar kernels refuse a matte transition", () => {
    expect(() => timelineTransitionMatteMixV1([0, 0, 0, 2], [0, 0, 0, 1], .5, undefined)).toThrow(/PIXEL_INVALID/);
    expect(() => timelineTransitionMatteMixV1([0, 0, 0, 1], [0, 0, 0, 1], NaN, undefined)).toThrow(/PIXEL_INVALID/);
    expect(() => timelineTransitionMixV1([0, 0, 0, 1], [0, 0, 0, 1], .5, "matte")).toThrow(/KERNEL_INVALID/);
    expect(() => timelineTransitionMatteStreamV1(2, "bad[label]", { startFrame: 0, durationFrames: 4 }, { fps: 30, duration: 1 })).toThrow(/GRAPH_LABEL/);
  });
});

describe("matte WGSL (new canonical source; the shipped shader is untouched)", () => {
  it("keeps timeline_transition_v1.wgsl byte-identical and reuses kernels 0 and 1 verbatim", async () => {
    const linear = timelineTransitionLinearShaderV1(), matte = timelineTransitionMatteShaderV1();
    expect(await readFile(resolve("spikes/gpu-compositor/src/timeline_transition_v1.wgsl"))).toEqual(Buffer.from(linear, "utf8"));
    for (const name of ["transition_pixel_v1", "transition_half_nearest_even_v1"]) {
      const start = linear.indexOf(`fn ${name}(`), block = linear.slice(start, linear.indexOf("\n}\n", start) + 3);
      expect(block.length).toBeGreaterThan(100);
      expect(matte).toContain(block);
    }
    for (const binding of ["@group(0) @binding(0) var from_texture: texture_2d<f32>;", "@group(0) @binding(1) var to_texture: texture_2d<f32>;",
      "@group(0) @binding(2) var<uniform> params: TransitionParams;"]) expect(matte).toContain(binding);
    expect(matte).toContain("@group(0) @binding(3) var matte_texture: texture_2d<f32>;");
    expect(matte).toContain("@group(0) @binding(4) var overlay_texture: texture_2d<f32>;");
    expect(matte).toContain("if(params.kernel==2u){return transition_matte_pixel_v1(position);}\n return transition_pixel_v1(position);");
    expect(linear).not.toContain("matte");
  });
  it("its f32 evaluation matches the CPU reference within 1/65535 on every fixture", () => {
    let maximum = 0, count = 0;
    for (const { a, b, m, o } of fixtures()) {
      const cpu = timelineTransitionMatteMixV1(a, b, m, o, "linear"), gpu = wgslMatteF32(a, b, m, o);
      for (let c = 0; c < 4; c += 1) maximum = Math.max(maximum, Math.abs(cpu[c] - gpu[c]) / Math.max(1, Math.abs(cpu[c])));
      count += 1;
    }
    expect(count).toBeGreaterThan(1000);
    expect(maximum).toBeLessThanOrEqual(1 / 65535);
  });
});

describe("native routes decline matte segments", () => {
  it("returns no resident preview graph, with a stable reason, while a dissolve project keeps its paired graph", () => {
    const base = motionLibraryFixtureProject();
    base.colorManagement = { mode: "aces2", workingSpace: "ACEScct", outputTransform: "rec709_sdr", configId: "studio-config-v4.0.0_aces-v2.0_ocio-v2.5" };
    const { field, matte, overlay } = fixtureTransitionField(base, 12);
    const project = applyCommand(base, { type: "batch", commands: [{ type: "import_asset", asset: matte }, { type: "import_asset", asset: overlay! },
      { type: "set_timeline_transition", transition: { schema: "editkin.timeline-transition/v1", id: "cut", trackId: "video-main", fromClipId: "a", toClipId: "b",
        beforeFrames: 6, afterFrames: 6, kernel: "matte", motionLibrary: field } }] });
    expect(timelineTransitionNativeDeclineV1(project)).toBe(TIMELINE_TRANSITION_NATIVE_MATTE_DECLINED);
    expect(buildGpuEngineVideoPreviewGraph(project, 2, undefined, undefined, 1)).toBeUndefined();
    expect(buildGpuEngineVideoPreviewGraph(project, 2)).toBeUndefined();
    const depth = structuredClone(project); depth.scene25d = structuredClone(DEFAULT_SCENE_25D);
    expect(buildGpuEngineVideoPreviewGraph(depth, 2, undefined, undefined, 1)).toBeUndefined();
  });
});
