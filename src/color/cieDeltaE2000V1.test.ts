import { describe, expect, it } from "vitest";
import { cieDeltaE2000V1, linearRec709ToCieLabD65V1 } from "./cieDeltaE2000V1";
import type { Vec3 } from "./gradeV2Color";

// Published numerical reference facts, including both sides of the 180° hue
// discontinuity and zero chroma. No third-party program code is incorporated.
// https://hajim.rochester.edu/ece/sites/gsharma/ciede2000/dataNprograms/ciede2000testdata.txt
const reference = [
  [50,2.6772,-79.7751,50,0,-82.7485,2.0425],
  [50,3.1571,-77.2803,50,0,-82.7485,2.8615],
  [50,2.8361,-74.0200,50,0,-82.7485,3.4412],
  [50,-1.3802,-84.2814,50,0,-82.7485,1],
  [50,-1.1848,-84.8006,50,0,-82.7485,1],
  [50,-.9009,-85.5211,50,0,-82.7485,1],
  [50,0,0,50,-1,2,2.3669], [50,-1,2,50,0,0,2.3669],
  [50,2.49,-.001,50,-2.49,.0009,7.1792],
  [50,2.49,-.001,50,-2.49,.0010,7.1792],
  [50,2.49,-.001,50,-2.49,.0011,7.2195],
  [50,2.49,-.001,50,-2.49,.0012,7.2195],
  [50,-.001,2.49,50,.0009,-2.49,4.8045],
  [50,-.001,2.49,50,.0010,-2.49,4.8045],
  [50,-.001,2.49,50,.0011,-2.49,4.7461],
  [50,2.5,0,50,0,-2.5,4.3065],
  [50,2.5,0,73,25,-18,27.1492],
  [50,2.5,0,61,-5,29,22.8977],
  [50,2.5,0,56,-27,-3,31.9030],
  [50,2.5,0,58,24,15,19.4535],
  [50,2.5,0,50,3.1736,.5854,1],
  [50,2.5,0,50,3.2972,0,1],
  [50,2.5,0,50,1.8634,.5757,1],
  [50,2.5,0,50,3.2592,.335,1],
  [60.2574,-34.0099,36.2677,60.4626,-34.1751,39.4387,1.2644],
  [63.0109,-31.0961,-5.8663,62.8187,-29.7946,-4.0864,1.2630],
  [61.2901,3.7196,-5.3901,61.4292,2.2480,-4.9620,1.8731],
  [35.0831,-44.1164,3.7933,35.0232,-40.0716,1.5901,1.8645],
  [22.7233,20.0904,-46.694,23.0331,14.973,-42.5619,2.0373],
  [36.4612,47.858,18.3852,36.2715,50.5065,21.2231,1.4146],
  [90.8027,-2.0831,1.441,91.1528,-1.6435,.0447,1.4441],
  [90.9257,-.5406,-.9208,88.6381,-.8985,-.7239,1.5381],
  [6.7747,-.2908,-2.4247,5.8714,-.0985,-2.2286,.6377],
  [2.0776,.0795,-1.135,.9033,-.0636,-.5514,.9082],
];

describe("CIEDE2000 published numerical controls", () => {
  it.each(reference.map((row, index) => ({ row, index: index + 1 })))
  ("matches published case $index in both directions within its 4-decimal precision", ({ row }) => {
    const a: Vec3 = [row[0], row[1], row[2]], b: Vec3 = [row[3], row[4], row[5]];
    expect(Math.abs(cieDeltaE2000V1(a, b) - row[6])).toBeLessThan(.000051);
    expect(Math.abs(cieDeltaE2000V1(b, a) - row[6])).toBeLessThan(.000051);
  });
  it("returns exact identity including achromatic and signed Lab triples", () => {
    for (const v of [[0,0,0],[100,0,0],[-12,3,-6],[50,0,42]] as Vec3[]) expect(cieDeltaE2000V1(v,v)).toBe(0);
  });
  it("rejects nonfinite, malformed and oversized Lab triples before arithmetic", () => {
    for (const bad of [[50,NaN,0],[50,0,Infinity],[50,10001,0],[50,0],[50,0,0,1],null]) {
      expect(() => cieDeltaE2000V1(bad as Vec3,[50,0,0])).toThrow();
      expect(() => cieDeltaE2000V1([50,0,0],bad as Vec3)).toThrow();
    }
  });
  it("uses the CIELAB piecewise neutral response, not Oklab or a camera OETF", () => {
    for (const y of [0,.001,216/24389,.18,1]) {
      const [l,a,b] = linearRec709ToCieLabD65V1([y,y,y]);
      const expected = y <= 216/24389 ? (24389/27)*y : 116*Math.cbrt(y)-16;
      expect(l).toBeCloseTo(expected,11); expect(a).toBeCloseTo(0,11); expect(b).toBeCloseTo(0,11);
    }
  });
  it("matches independently tabulated Rec.709 primary CIELAB coordinates", () => {
    const lab = linearRec709ToCieLabD65V1([1,0,0]);
    expect(lab[0]).toBeCloseTo(53.2371156,6);
    expect(lab[1]).toBeCloseTo(80.0901135,6);
    expect(lab[2]).toBeCloseTo(67.2032635,6);
  });
  it("preserves signed/out-of-display-range linear input and bounds unsupported extremes", () => {
    const lab = linearRec709ToCieLabD65V1([-.1,-.1,-.1]);
    expect(lab[0]).toBeLessThan(0); expect(lab[1]).toBeCloseTo(0,10);
    expect(linearRec709ToCieLabD65V1([2,2,2])[0]).toBeGreaterThan(100);
    for (const bad of [[NaN,0,0],[65,0,0],[0,Infinity,0],[0,0],null]) {
      expect(() => linearRec709ToCieLabD65V1(bad as Vec3)).toThrow();
    }
  });
});
