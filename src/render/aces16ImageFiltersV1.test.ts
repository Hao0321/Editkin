import { describe, expect, it } from "vitest";
import { aces16ClipImageGraphV1, aces16ColourFiltersV1, aces16ImageFilterChainsV1, aces16SurfaceFilterV1 } from "./aces16ImageFiltersV1";
describe("16-bit photographic image lane", () => {
  it("preserves float alpha and adapts frozen8-bit surface constants only in generated filters", () => {
    expect(aces16SurfaceFilterV1("[in]format=gbrpf32le,lut3d=file='owned.cube',format=rgba[out]")).toBe("[in]format=gbrapf32le,lut3d=file='owned.cube',format=gbrap16le[out]");
    expect(aces16SurfaceFilterV1("geq=a='255*(alpha(X,Y)/255)'")).toBe("geq=a='65535*(alpha(X,Y)/65535)'");
    expect(aces16SurfaceFilterV1("format=gbrp16le")).toBe("format=gbrp16le");
  });
  it("keeps labelled source and output scales bounded without splitting quoted LUT paths", () => {
    expect(aces16SurfaceFilterV1("[2:v]scale=64:32,format=gbrap16le,lut=a=65535,lut3d=file='owned,part;one.cube',scale=32:16:threads=4[out]")).toBe(
      "[2:v]scale=64:32:threads=1,format=gbrap16le,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a=65535:interpolation=nearest,lut3d=file='owned,part;one.cube',scale=32:16:threads=1[out]");
    expect(aces16SurfaceFilterV1("[in]lut=a=32768[out]")).toBe("[in]lut=a=32768[out]");
  });
  it("converts colour time variables and retains the init/frame evaluation contract", () => {
    expect(aces16ColourFiltersV1("eq=brightness=t:eval=frame").join(",")).toContain("65535*(T)");
    expect(aces16ColourFiltersV1("eq=brightness=t:eval=init").join(",")).toContain("65535*(0)");
    expect(() => aces16ColourFiltersV1("eq=gamma=2")).toThrow();
    expect(() => aces16ColourFiltersV1("eq=eval=other")).toThrow();
  });
  it("isolates solid-colour graphics and uses coverage on the alpha mask too when replacing", () => {
    const graph = aces16ImageFilterChainsV1("in", "out", ["drawbox=x=8:y=8:w=16:h=8:color=red@.5:t=fill:replace=1"], "fx").join(";");
    expect(graph).toContain("maskedmerge=planes=15"); expect(graph).toContain("a='if(gt(alpha(X,Y),0),65535,0)'");
    expect(graph).toContain("geq=r=0:g=0:b=0:a=0,format=rgba,drawbox=");
  });
  it("keeps disabled colour adjustment pixels exact through an independent enable mask", () => {
    const graph = aces16ImageFilterChainsV1("in", "out", ["eq=brightness=.1:eval=frame:enable=gt(t,0)"], "fx").join(";");
    expect(graph).toContain("split=3"); expect(graph).toContain("65535*(gt(T\\,0))"); expect(graph).toContain("maskedmerge=planes=7");
  });
  it("keeps already premultiplied geometry associated exactly once", () => {
    const graph = aces16ImageFilterChainsV1("in", "out", ["premultiply=inplace=1", "perspective=interpolation=cubic", "unpremultiply=inplace=1"], "fx").join(";");
    expect(graph.match(/,?\bpremultiply=inplace=1/g)).toHaveLength(1); expect(graph.match(/\bunpremultiply=inplace=1/g)).toHaveLength(1);
  });
  it("continues an existing mask label and reattaches project time without an extra output label", () => {
    const graph = aces16ClipImageGraphV1({ head: "[merged]", output: "out", preImage: [], gradeLut: [], postImage: [], finishTail: ["setpts=PTS-STARTPTS[out]"], space: "acescct", canvasHeight: 32 }).join(";");
    expect(graph).toContain("[merged]null["); expect(graph).toContain("setpts=PTS-STARTPTS[out]"); expect(graph.match(/\[out\]/g)).toHaveLength(1);
  });
});
