import { describe, expect, it } from "vitest";
import { analyzeShotGradeStatisticsV1, measureShotGradeMatchV1, measureShotGradeSafetyV1,
  type ShotGradeFrameV1, type ShotGradeRegionV1, type ShotGradeStatisticsV1 } from "./shotGradeStatisticsV1";
import { linearRec709ToWorking, oklabToWorking, type Vec3 } from "./gradeV2Color";

const frame = (rgb: readonly Vec3[], patch: Partial<ShotGradeFrameV1> = {}): ShotGradeFrameV1 => ({
  sampleId:"kf-0",timeSeconds:0,width:rgb.length,height:1,workingSpace:"rec709_display",
  stage:"clip_working_pre_v2",format:"rgb64f",pixels:new Float64Array(rgb.flat()),...patch,
});
const region = (role: ShotGradeRegionV1["role"], patch: Partial<ShotGradeRegionV1> = {}): ShotGradeRegionV1 =>
  ({sampleId:"kf-0",role,x:0,y:0,width:1,height:1,...patch});
const rgbAtHue = (hue: number, l=.6, c=.04): Vec3 => oklabToWorking([l,c*Math.cos(hue*Math.PI/180),c*Math.sin(hue*Math.PI/180)],"rec709_display");

describe("bounded shot grade statistics", () => {
  it("measures exact BT.1886 Oklab neutral quantiles with nearest ranks and no input mutation", () => {
    const values=[.8,.1,.6,.3,.9,.2,.4,.7,.5,0], input=frame(values.map(v=>[v,v,v]));
    const original=Array.from(input.pixels), stats=analyzeShotGradeStatisticsV1([input]);
    expect(stats.oklab.l.quantiles).toEqual(expect.arrayContaining([expect.any(Number)]));
    const expected=[0,.2,.4,.7,.9].map(v=>v**.8);
    stats.oklab.l.quantiles.forEach((v,i)=>expect(v).toBeCloseTo(expected[i],11));
    expect(stats.oklab.a.minimum).toBeCloseTo(0,12); expect(stats.oklab.b.maximum).toBeCloseTo(0,12);
    expect(stats.oklab.l.mean).toBeCloseTo(values.reduce((s,v)=>s+v**.8,0)/10,11);
    expect(stats.quantileMethod).toBe("exact-nearest-rank");expect(stats.quantileProbabilities).toEqual([.05,.25,.5,.75,.95]);
    expect(Array.from(input.pixels)).toEqual(original);
  });
  it("weights supplied pixels rather than giving differently sized frames equal weight", () => {
    const a=frame([[.2,.2,.2]]),b=frame(Array.from({length:3},()=>[.8,.8,.8] as Vec3),{sampleId:"kf-1",timeSeconds:1});
    const stats=analyzeShotGradeStatisticsV1([a,b],[region("neutral"),region("neutral",{sampleId:"kf-1"})]);
    expect(stats.pixelCount).toBe(4);expect(stats.oklab.l.mean).toBeCloseTo((.2**.8+3*.8**.8)/4,11);
    expect(stats.regions.neutral.pixelCount).toBe(4);
  });
  it("takes pixel centres in half-open ROIs and counts same-role overlaps once", () => {
    const input=frame([[.1,.1,.1],[.3,.3,.3],[.7,.7,.7],[.9,.9,.9]]);
    const stats=analyzeShotGradeStatisticsV1([input],[region("neutral",{x:.125,width:.5}),region("neutral",{x:.375,width:.25})]);
    expect(stats.regions.neutral.pixelCount).toBe(2);
    expect(stats.regions.neutral.meanOklab![0]).toBeCloseTo((.1**.8+.3**.8)/2,11);
  });
  it("rejects contradictory roles and subpixel ROIs with no sample centre", () => {
    const input=frame([[.2,.2,.2],[.3,.3,.3]]);
    expect(()=>analyzeShotGradeStatisticsV1([input],[region("neutral"),region("skin")])).toThrow("Conflicting roles");
    expect(()=>analyzeShotGradeStatisticsV1([input],[region("skin",{width:.1})])).toThrow("no pixel centre");
  });
  it("averages per-pixel CIELAB rather than converting the mean RGB afterwards", () => {
    const stats=analyzeShotGradeStatisticsV1([frame([[.2,.2,.2],[.8,.8,.8]])],[region("neutral")]);
    const expected=(116*(.2**2.4)**(1/3)-16 + 116*(.8**2.4)**(1/3)-16)/2;
    expect(stats.regions.neutral.meanCieLabD65![0]).toBeCloseTo(expected,11);
    const meanLinear=(.2**2.4+.8**2.4)/2;
    expect(stats.regions.neutral.meanLinearRec709![0]).toBeCloseTo(meanLinear,12);
    expect(Math.abs(stats.regions.neutral.meanCieLabD65![0]-(116*Math.cbrt(meanLinear)-16))).toBeGreaterThan(1);
  });
  it("keeps absent groups unmeasured and labels provided roles as caller declarations", () => {
    const stats=analyzeShotGradeStatisticsV1([frame([rgbAtHue(50)])]);
    expect(stats.regions.skin).toMatchObject({selection:"caller-declared-regions",pixelCount:0,meanCieLabD65:null,meanOklabHueDegrees:null});
    expect(stats.interpretation).toMatchObject({regionSemantics:"caller-declared-not-classified",sensorClippingMeasured:false});
  });
  it("reads packed RGB8, RGB16 and nonzero-offset views using their stated denominators", () => {
    for(const [format,pixels,value] of [
      ["rgb8",new Uint8Array([50,50,50]),50/255],
      ["rgb16",new Uint16Array([32768,32768,32768]),32768/65535],
      ["rgb32f",new Float32Array([.25,.25,.25]),.25],
      ["rgb64f",new Float64Array([9,.25,.25,.25,9]).subarray(1,4),.25],
    ] as Array<[ShotGradeFrameV1["format"],ShotGradeFrameV1["pixels"],number]>) {
      const stats=analyzeShotGradeStatisticsV1([frame([[0,0,0]],{format,pixels})]);
      expect(stats.oklab.l.mean).toBeCloseTo(value**.8,10);
    }
  });
  it("preserves signed/wide Rec.709 values and counts each endpoint pixel once", () => {
    const input=frame([[-.1,.2,.4],[1.1,.3,.2],[0,1,.5],[.3,.4,.5]]),before=Array.from(input.pixels);
    const stats=analyzeShotGradeStatisticsV1([input]);
    expect(stats.displaySurfaceEndpoints).toEqual({low:2,high:2,any:3,fraction:.75});
    expect(Array.from(input.pixels)).toEqual(before);
    expect(stats.oklab.a.minimum).toBeLessThan(0);
  });
  it("reuses the existing ACEScct D60-to-D65 working conversion and withholds SDR endpoint claims", () => {
    const linear:Vec3=[.4,.4,.4],aces=linearRec709ToWorking(linear,"acescct"),display=linearRec709ToWorking(linear,"rec709_display");
    const a=analyzeShotGradeStatisticsV1([frame([aces],{workingSpace:"acescct"})],[region("neutral")]);
    const b=analyzeShotGradeStatisticsV1([frame([display])],[region("neutral")]);
    expect(a.oklab.l.mean).toBeCloseTo(b.oklab.l.mean,11);
    expect(a.regions.neutral.meanCieLabD65![0]).toBeCloseTo(b.regions.neutral.meanCieLabD65![0],10);
    expect(a.displaySurfaceEndpoints).toBeNull();expect(a.interpretation.sdrOutputTransformMeasured).toBe(false);
  });
  it("rejects unsupported buffer layouts, types, channels and metadata", () => {
    const base=frame([[.4,.3,.2]]);
    for(const patch of [
      {format:"rgb8",pixels:new Float32Array(3)}, {pixels:new Float64Array(4)},
      {pixels:new Float64Array([0,NaN,0])}, {pixels:new Float64Array([0,Infinity,0])},
      {pixels:new Float64Array([4.1,0,0])}, {workingSpace:"pq"}, {stage:"raw-source"},
      {workingSpace:"acescct",stage:"final_output_sdr"},{workingSpace:"acescct",pixels:new Float64Array([1,1,1])},
    ]) expect(()=>analyzeShotGradeStatisticsV1([{...base,...patch} as ShotGradeFrameV1])).toThrow();
  });
  it("rejects shared and resizable buffers instead of observing a changing surface", () => {
    const shared=new Float64Array(new SharedArrayBuffer(24));
    expect(()=>analyzeShotGradeStatisticsV1([frame([[0,0,0]],{pixels:shared})])).toThrow("Shared/resizable");
    const buffer=Reflect.construct(ArrayBuffer,[24,{maxByteLength:48}]) as ArrayBuffer;
    expect(()=>analyzeShotGradeStatisticsV1([frame([[0,0,0]],{pixels:new Float64Array(buffer)})])).toThrow("Shared/resizable");
  });
  it("refuses invalid dimensions, clocks, IDs and oversized batches without downsampling", () => {
    const base=frame([[.4,.4,.4]]);
    for(const patch of [{width:0},{width:65537},{height:1.5},{sampleId:""},{timeSeconds:-1},{timeSeconds:NaN}]) {
      expect(()=>analyzeShotGradeStatisticsV1([{...base,...patch}])).toThrow();
    }
    expect(()=>analyzeShotGradeStatisticsV1([])).toThrow();
    expect(()=>analyzeShotGradeStatisticsV1([base,{...base,sampleId:"kf-1"}])).toThrow("increasing");
    expect(()=>analyzeShotGradeStatisticsV1([base,{...base,timeSeconds:1}])).toThrow("duplicate");
    expect(()=>analyzeShotGradeStatisticsV1(Array.from({length:9},(_,i)=>({...base,sampleId:`kf-${i}`,timeSeconds:i})))).toThrow("count");
    const pixels=new Uint8Array(256*256*3).fill(128);
    expect(()=>analyzeShotGradeStatisticsV1(Array.from({length:5},(_,i)=>({...base,sampleId:`kf-${i}`,timeSeconds:i,width:256,height:256,format:"rgb8",pixels})))).toThrow("budget");
  });
  it("rejects malformed, unknown and excessive declared regions", () => {
    const input=frame([[.5,.5,.5]]);
    for(const patch of [{sampleId:"absent"},{role:"person"},{x:-.1},{x:.1,width:1},{width:0},{height:NaN}]) {
      expect(()=>analyzeShotGradeStatisticsV1([input],[{...region("skin"),...patch} as ShotGradeRegionV1])).toThrow();
    }
    expect(()=>analyzeShotGradeStatisticsV1([input],Array.from({length:33},()=>region("skin")))).toThrow("count");
  });
});

describe("paired colour safety and reference distances", () => {
  it("measures circular hue through the 0-degree seam with fixed pixel membership", () => {
    const before=analyzeShotGradeStatisticsV1([frame([rgbAtHue(359)])],[region("skin")]);
    const after=analyzeShotGradeStatisticsV1([frame([rgbAtHue(1)],{stage:"clip_working_post_v2"})],[region("skin")]);
    const safety=measureShotGradeSafetyV1(before,after);
    expect(safety.hueChanges.skin.maximumAbsoluteDegrees).toBeCloseTo(2,8);
    expect(safety.hueChanges.skin.withinMeasuredLimit).toBe(true);
    expect(safety.missingDeclaredHueRoles).toEqual(["food","sky"]);
    expect(safety.neutralWhiteAccuracy.status).toBe("unmeasured");expect(safety.appearanceCertified).toBe(false);
  });
  it("checks the worst selected pixel so a stable mean cannot hide an unsafe colour change", () => {
    const before=analyzeShotGradeStatisticsV1([frame([rgbAtHue(40),rgbAtHue(40)])],[region("food")]);
    const after=analyzeShotGradeStatisticsV1([frame([rgbAtHue(50),rgbAtHue(30)])],[region("food")]);
    const safety=measureShotGradeSafetyV1(before,after);
    expect(safety.hueChanges.food.maximumAbsoluteDegrees).toBeCloseTo(10,8);
    expect(safety.hueChanges.food.withinMeasuredLimit).toBe(false);expect(safety.measuredBoundsSatisfied).toBe(false);
  });
  it("uses the stated skin/food 8-degree and sky 10-degree limits", () => {
    for(const [role,inside,outside] of [["skin",7.99,8.01],["food",7.99,8.01],["sky",9.99,10.01]] as const) {
      const before=analyzeShotGradeStatisticsV1([frame([rgbAtHue(50)])],[region(role)]);
      for(const [delta,allowed] of [[inside,true],[outside,false]] as const) {
        const after=analyzeShotGradeStatisticsV1([frame([rgbAtHue(50+delta)])],[region(role)]);
        expect(measureShotGradeSafetyV1(before,after).hueChanges[role].withinMeasuredLimit).toBe(allowed);
      }
    }
  });
  it("keeps achromatic or disappeared hue partially measured and refuses a hue safety pass", () => {
    const before=analyzeShotGradeStatisticsV1([frame([rgbAtHue(50),[.4,.4,.4]])],[region("skin")]);
    const after=analyzeShotGradeStatisticsV1([frame([rgbAtHue(50),[.4,.4,.4]])],[region("skin")]);
    const result=measureShotGradeSafetyV1(before,after).hueChanges.skin;
    expect(result).toMatchObject({status:"partially_measured",measuredPixels:1,undefinedHuePixels:1,withinMeasuredLimit:false});
  });
  it("uses 0.5 percentage points as a fraction and includes newly out-of-range display pixels", () => {
    const rgb=Array.from({length:200},()=>[.5,.5,.5] as Vec3),baseline=frame(rgb);
    const before=analyzeShotGradeStatisticsV1([baseline]);
    for(const [number,allowed] of [[1,true],[2,false]] as const) {
      const updated=rgb.map((v,i)=>i<number ? [1.01,.5,.5] as Vec3 : v);
      const after=analyzeShotGradeStatisticsV1([frame(updated)]);
      const endpoints=measureShotGradeSafetyV1(before,after).displaySurfaceEndpoints;
      expect(endpoints).toMatchObject({increaseFraction:number/200,maximumIncreaseFraction:.005,withinMeasuredLimit:allowed});
    }
  });
  it("does not claim an SDR endpoint gate for ACES working code values", () => {
    const aces=linearRec709ToWorking([.4,.2,.1],"acescct");
    const a=analyzeShotGradeStatisticsV1([frame([aces],{workingSpace:"acescct"})],[region("skin")]);
    const b=analyzeShotGradeStatisticsV1([frame([aces],{workingSpace:"acescct"})],[region("skin")]);
    expect(measureShotGradeSafetyV1(a,b).displaySurfaceEndpoints.status).toBe("unmeasured");
    expect(measureShotGradeSafetyV1(a,b).measuredBoundsSatisfied).toBe(false);
  });
  it("binds paired clocks, geometry, colour stage and exact projected regions", () => {
    const input=frame([[.4,.4,.4],[.5,.5,.5]]),before=analyzeShotGradeStatisticsV1([input],[region("neutral",{width:.5})]);
    for(const [patch,regions] of [
      [{timeSeconds:1},[region("neutral",{width:.5})]],
      [{width:1,height:2},[region("neutral",{height:.5})]],
      [{stage:"final_output_sdr"},[region("neutral",{width:.5})]],
      [{},[region("neutral",{x:.5,width:.5})]],
    ] as Array<[Partial<ShotGradeFrameV1>,ShotGradeRegionV1[]]>) {
      const after=analyzeShotGradeStatisticsV1([{...input,...patch}],regions);
      expect(()=>measureShotGradeSafetyV1(before,after)).toThrow();
    }
  });
  it("ignores caller mutations of report fields and rejects forged or deserialized reports", () => {
    const input=frame([rgbAtHue(50)]),before=analyzeShotGradeStatisticsV1([input],[region("skin")]);
    const after=analyzeShotGradeStatisticsV1([input],[region("skin")]);
    before.displaySurfaceEndpoints!.fraction=1;before.regions.skin.pixelCount=0;
    expect(measureShotGradeSafetyV1(before,after).hueChanges.skin.measuredPixels).toBe(1);
    expect(measureShotGradeSafetyV1(before,after).displaySurfaceEndpoints).toMatchObject({beforeFraction:0,afterFraction:0});
    expect(()=>measureShotGradeSafetyV1(structuredClone(before),after)).toThrow("this instrument");
    expect(()=>measureShotGradeMatchV1(before,after,{} as ShotGradeStatisticsV1)).toThrow("this instrument");
  });
  it("reports the specified neutral and skin CIEDE2000 improvements independently of Oklab quantiles", () => {
    const regions=[region("neutral",{width:.5}),region("skin",{x:.5,width:.5})];
    const source=frame([oklabToWorking([.5,0,0],"rec709_display"),rgbAtHue(50,.55)]);
    const target=frame([oklabToWorking([.7,0,0],"rec709_display"),rgbAtHue(50,.7)]);
    const before=analyzeShotGradeStatisticsV1([source],regions),after=analyzeShotGradeStatisticsV1([target],regions);
    const reference=analyzeShotGradeStatisticsV1([target],regions),result=measureShotGradeMatchV1(before,after,reference);
    expect(result.metric).toBe("CIEDE2000-kL-kC-kH-1");
    for(const group of Object.values(result.groups)) expect(group).toMatchObject({status:"measured",afterDeltaE00:0,reductionFraction:1,matchesSpecifiedBounds:true});
    expect(result.matchesSpecifiedNeutralAndSkinBounds).toBe(true);
    expect(result.oklabMarginalQuantileDistance.before).toBeGreaterThan(.1);expect(result.oklabMarginalQuantileDistance.after).toBe(0);
  });
  it("requires both 50% reduction and absolute DeltaE00 <=4, and keeps missing means unmeasured", () => {
    const regions=[region("neutral",{width:.5}),region("skin",{x:.5,width:.5})];
    const shape=(l:number)=>frame([oklabToWorking([l,0,0],"rec709_display"),rgbAtHue(50,l)]);
    const before=analyzeShotGradeStatisticsV1([shape(.3)],regions),after=analyzeShotGradeStatisticsV1([shape(.55)],regions),reference=analyzeShotGradeStatisticsV1([shape(.8)],regions);
    const result=measureShotGradeMatchV1(before,after,reference);
    expect(result.groups.neutral.afterDeltaE00!).toBeGreaterThan(4);expect(result.matchesSpecifiedNeutralAndSkinBounds).toBe(false);
    const near=analyzeShotGradeStatisticsV1([shape(.79)],regions);
    expect(measureShotGradeMatchV1(near,near,reference).groups.skin.matchesSpecifiedBounds).toBe(false);
    const undeclared=analyzeShotGradeStatisticsV1([shape(.8)]);
    expect(measureShotGradeMatchV1(before,after,undeclared).groups.skin.status).toBe("unmeasured");
  });
  it("handles an already exact reference with zero distance without dividing by zero", () => {
    const regions=[region("neutral",{width:.5}),region("skin",{x:.5,width:.5})],input=frame([[.5,.5,.5],rgbAtHue(50)]);
    const a=analyzeShotGradeStatisticsV1([input],regions),b=analyzeShotGradeStatisticsV1([input],regions);
    const result=measureShotGradeMatchV1(a,b,b);
    expect(result.matchesSpecifiedNeutralAndSkinBounds).toBe(true);
    expect(result.groups.skin.reductionFraction).toBeNull();
  });
  it("rejects cross-working-space reference comparisons", () => {
    const input=frame([[.4,.4,.4]]),a=analyzeShotGradeStatisticsV1([input]),b=analyzeShotGradeStatisticsV1([input]);
    const aces=analyzeShotGradeStatisticsV1([frame([linearRec709ToWorking([.2,.2,.2],"acescct")],{workingSpace:"acescct"})]);
    expect(()=>measureShotGradeMatchV1(a,b,aces)).toThrow("Reference working-space");
  });
});
