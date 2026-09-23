import { describe, expect, it } from "vitest";
import { compileGpuEffectModule, type GpuEffectModule } from "./effectSdk";

function module(nodes: GpuEffectModule["nodes"], output: string): GpuEffectModule {
  return { schema: "editkin.gpu-effect-module/v1", nodes, output };
}

describe("GPU effect module SDK", () => {
  it("compiles an authored reverse listing into source-to-output order", () => {
    const compiled = compileGpuEffectModule(module([
      { id: "curve", input: "balance", op: "filmic_curve", args: [0.2, 0.1, 0.2] },
      { id: "balance", input: "$source", op: "temperature_tint", args: [0.08, 0.02] },
    ], "curve"));
    expect(compiled.map((node) => node.id)).toEqual(["balance", "curve"]);
  });

  it("fails closed on cycles, missing inputs and orphan nodes", () => {
    expect(() => compileGpuEffectModule(module([
      { id: "a", input: "b", op: "gain", args: [1] },
      { id: "b", input: "a", op: "gain", args: [1] },
    ], "a"))).toThrow(/循環/);
    expect(() => compileGpuEffectModule(module([
      { id: "a", input: "missing", op: "gain", args: [1] },
    ], "a"))).toThrow(/不存在/);
    expect(() => compileGpuEffectModule(module([
      { id: "a", input: "$source", op: "gain", args: [1] },
      { id: "orphan", input: "$source", op: "invert", args: [0.5] },
    ], "a"))).toThrow(/未連到 output/);
  });
});
