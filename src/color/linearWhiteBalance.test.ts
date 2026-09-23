import { describe, expect, it } from "vitest";
import { getLinearWhiteBalanceStops as stops, hasLinearWhiteBalance as active, linearWhiteBalanceFilters as filters, solveLinearWhiteBalanceStops as solve } from "./linearWhiteBalance";
describe("explicit linear Rec709 white balance math", () => {
  it("defaults absent stops only and keeps zero an empty filter identity", () => {
    expect(stops({})).toEqual([0,0,0]); expect(filters({})).toEqual([]); expect(active({whiteBalanceRed:0})).toBe(false);
    expect(active({whiteBalanceGreen:.01})).toBe(true);
  });
  it("rejects invalid stops rather than clamp, preserving valid extrema", () => {
    for(const value of [NaN,Infinity,-4.001,4.001,null,"1"]) expect(()=>stops({whiteBalanceRed:value as number})).toThrow();
    expect(stops({whiteBalanceRed:-4,whiteBalanceBlue:4})).toEqual([-4,0,4]);
    expect(filters({whiteBalanceRed:1})[0]).toContain("r(X,Y)*2");
    expect(filters({whiteBalanceRed:1})[0]).toContain("alpha(X,Y)");
    expect(filters({whiteBalanceRed:1})[0]).not.toMatch(/format=|clip\(/);
  });
  it("preserves reference luminance and produces absolute baseline-aware stops", () => {
    const mean:[number,number,number]=[.3,.25,.2], baseline={whiteBalanceRed:.4,whiteBalanceGreen:-.1,whiteBalanceBlue:.2};
    const result=solve(mean,baseline,1); expect(result.status).toBe("candidate");
    const corrected=mean.map((v,i)=>v*2**result.relativeStops[i]);
    corrected.forEach(v=>expect(v).toBeCloseTo(result.targetLinearY,12));
    expect(result.stops).toEqual(stops(baseline).map((v,i)=>v+result.relativeStops[i]));
    expect(solve([2,2,2],{},1).status).toBe("unchanged");
  });
  it("reports unreachable stops without clamping into false success", () => {
    expect(solve([.3,.25,.2],{},.01).status).toBe("out-of-range");
    const result=solve([.1,.2,.2],{whiteBalanceRed:4},2);
    expect(result.status).toBe("out-of-range"); expect(result.stops[0]).toBeGreaterThan(4);
    for(const mean of [[0,1,1],[-1,1,1],[NaN,1,1],[Infinity,1,1]]) expect(()=>solve(mean as [number,number,number],{},1)).toThrow();
    for(const bound of [0,NaN,4.01]) expect(()=>solve([1,1,1],{},bound)).toThrow();
  });
});
