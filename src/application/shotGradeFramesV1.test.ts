import {describe,expect,it} from "vitest";
import {createEmptyProject} from "../domain/editGraph";
import {DEFAULT_COLOR,DEFAULT_COLOR_MANAGEMENT,DEFAULT_TRANSFORM,type TimelineClip} from "../domain/types";
import {shotGradeFramePlanV1,unpackShotGradeWorkingPixelsV1} from "./shotGradeFramesV1";

function fixture() {
  const project = createEmptyProject("Stage bounds",{width:640,height:360,fps:30});
  const asset = {id:"a",name:"Source",uri:"owned.mkv",kind:"video" as const,duration:2,width:640,height:360,
    color:{interpretation:"rec709" as const}};
  const clip:TimelineClip = {id:"c",assetId:"a",trackId:project.tracks[0].id,timelineStart:4,sourceStart:0,duration:2,
    volume:0,transform:{...DEFAULT_TRANSFORM},color:{...DEFAULT_COLOR},keyframes:[]};
  const probe = {hasVideo:true,hasAudio:false,duration:2,width:640,height:360,encodedWidth:640,encodedHeight:360,
    sampleAspectRatio:1,colorPrimaries:"bt709",colorTransfer:"bt709",colorMatrix:"bt709",colorRange:"tv"};
  project.assets.push(asset); project.tracks[0].clips.push(clip);
  return {project,asset,clip,probe};
}
describe("actual pre-grade source stage planning",() => {
  it("keeps the full stage raster before bounded sampling and preserves caller state",() => {
    const f = fixture(), before = structuredClone(f), plan = shotGradeFramePlanV1(f.project,f.clip,f.asset,f.probe);
    expect(f).toEqual(before);
    expect(plan).toMatchObject({stage:"clip_working_pre_v2",workingSpace:"rec709_display",pixelFormat:"rgba",width:256,height:144,
      geometry:{layerWidth:640,layerHeight:360,roiBasis:"pre-grade-layer-raster-normalized"},
      sampling:{resampled:true,pointwisePredictionIsFinalOutputProof:false},downstream:{finalOutputMeasured:false}});
    expect(plan.filters.indexOf("scale=256:144:flags=area")).toBeGreaterThan(plan.filters.indexOf("pad=640:360:(ow-iw)/2:(oh-ih)/2:color=black@0"));
  });
  it("includes primary exposure/tone and the frozen legacy look in their actual order",() => {
    const f = fixture(); f.clip.color = {...DEFAULT_COLOR,exposure:.2,shadows:.1,hue:3};
    f.clip.creative = {lookPresetId:"cinematic_warm_soft",effectPresetIds:[]};
    const plan = shotGradeFramePlanV1(f.project,f.clip,f.asset,f.probe), filters = plan.filters.join(",");
    expect(filters.indexOf("curves=master=")).toBeGreaterThan(0);
    expect(filters.indexOf("exposure=exposure=0.2")).toBeGreaterThan(filters.indexOf("curves=master="));
    expect(filters.indexOf("eq=brightness=")).toBeGreaterThan(filters.indexOf("exposure=exposure=0.2"));
    expect(filters).toContain("brightness='(0)+(-0.01)+(0)'");
    expect(filters).toContain("contrast='(1)*(1.08)'");
    expect(filters).toContain("saturation='(1)*(0.94)'");
    expect(filters).toContain("hue=h='(3)+(5)'");
    expect(filters.indexOf("eq=brightness=")).toBeLessThan(filters.indexOf("scale=256:144:flags=area"));
  });
  it("records real anamorphic geometry and refuses a contradictory saved physical ratio",() => {
    const f = fixture(); f.probe.sampleAspectRatio = 2;
    const asset = {...f.asset,displayAspectRatio:32/9};
    const plan = shotGradeFramePlanV1(f.project,f.clip,asset,f.probe);
    expect(plan.geometry.physicalDisplayAspectRatio).toBe(32/9);
    expect(plan.filters[0]).toContain(":force_divisible_by=2:reset_sar=1");
    expect(() => shotGradeFramePlanV1(f.project,f.clip,{...asset,displayAspectRatio:16/9},f.probe)).toThrow(/展示比例/);
  });
  it("does not invent square pixels for a probe with unknown SAR",() => {
    const f = fixture(), probe = {...f.probe,sampleAspectRatio:undefined};
    expect(shotGradeFramePlanV1(f.project,f.clip,f.asset,probe).geometry).toMatchObject({sampleAspectRatio:null,physicalDisplayAspectRatio:null});
    expect(() => shotGradeFramePlanV1(f.project,f.clip,{...f.asset,displayAspectRatio:16/9},probe)).toThrow(/SAR/);
  });
  it("verifies upright raster separately from the encoded raster",() => {
    const f = fixture(), probe = {...f.probe,displayRotationDegrees:-90};
    const plan = shotGradeFramePlanV1(f.project,f.clip,{...f.asset,width:360,height:640,displayAspectRatio:9/16},probe);
    expect(plan.geometry).toMatchObject({encodedWidth:640,encodedHeight:360,uprightWidth:360,uprightHeight:640,
      physicalDisplayAspectRatio:9/16,displayRotationDegrees:-90});
    expect(() => shotGradeFramePlanV1(f.project,f.clip,f.asset,probe)).toThrow(/展示尺寸/);
    expect(() => shotGradeFramePlanV1(f.project,f.clip,f.asset,{...probe,displayRotationDegrees:12})).toThrow(/旋轉/);
  });
  it("binds ROI to the cropped layer raster and places associated-alpha geometry before primary",() => {
    const f = fixture(); f.clip.layout = {crop:{x:.1,y:.1,width:.8,height:.8},viewport:{x:.1,y:.2,width:.5,height:.5}};
    const plan = shotGradeFramePlanV1(f.project,f.clip,f.asset,f.probe,200,true);
    expect(plan).toMatchObject({width:200,height:112,pixelFormat:"gbrap16le",geometry:{layerWidth:320,layerHeight:180,
      crop:{x:.1,y:.1,width:.8,height:.8}}});
    expect(plan.filters).toEqual(expect.arrayContaining(["premultiply=inplace=1","crop=512:288:64:36","scale=320:180:flags=lanczos","unpremultiply=inplace=1"]));
    const malformed = {...f.clip,layout:{...f.clip.layout,crop:{x:.8,y:0,width:.4,height:1}}};
    expect(() => shotGradeFramePlanV1(f.project,malformed,f.asset,f.probe)).toThrow(/crop/);
  });
  it("declares an actual HDR rgba8 barrier even when readback is sixteen-bit",() => {
    const f = fixture(), asset = {...f.asset,color:{interpretation:"hlg" as const,primaries:"bt2020",transfer:"arib-std-b67",matrix:"bt2020nc",range:"tv"}};
    f.clip.color.exposure = .2;
    const probe = {...f.probe,colorPrimaries:"bt2020",colorTransfer:"arib-std-b67",colorMatrix:"bt2020nc"};
    const plan = shotGradeFramePlanV1(f.project,f.clip,asset,probe,256,true);
    expect(plan).toMatchObject({exposureConsumed:true,format:"rgb16",precision:{explicitRgba8Barrier:true,
      readbackBits:16,originalSourcePrecisionVerified:false,negotiatedIntermediatePrecisionMeasured:false}});
    expect(plan.filters.filter(v => v.startsWith("exposure="))).toEqual(["exposure=exposure=0.2:black=0"]);
  });
  it("keeps nonzero source-linear white balance in the actual shared source plan",() => {
    const f = fixture(); f.clip.color.whiteBalanceRed = .1;
    const plan = shotGradeFramePlanV1(f.project,f.clip,f.asset,f.probe);
    expect(plan.filters.some(v => v.includes("geq="))).toBe(true);
    expect(plan.exposureConsumed).toBe(false);
    expect(plan.precision.originalSourcePrecisionVerified).toBe(false);
    expect(() => shotGradeFramePlanV1(f.project,f.clip,f.asset,{...f.probe,colorPrimaries:"bt2020"})).toThrow();
  });
  it("does not label unmeasured animated, retimed or controller contexts as static source frames",() => {
    const f = fixture();
    expect(() => shotGradeFramePlanV1(f.project,{...f.clip,expressions:{x:"hao.expression/v1:time"}},f.asset,f.probe)).toThrow(/Animated/);
    expect(() => shotGradeFramePlanV1(f.project,{...f.clip,layer:{enabled:true,blendMode:"normal",role:"controller"}},f.asset,f.probe)).toThrow(/context/);
    expect(() => shotGradeFramePlanV1(f.project,f.clip,{...f.asset,clipRetime:{schema:"editkin.clip-retime/v1",sourceAssetId:"original",sourceStart:0,sourceDuration:2,rate:2,reverse:false}},f.probe)).toThrow(/frame-clock/);
  });
  it("requires an actual ACES working/output adapter rather than an SDR label",() => {
    const f = fixture(); f.project.colorManagement = {...DEFAULT_COLOR_MANAGEMENT,mode:"aces2"};
    expect(() => shotGradeFramePlanV1(f.project,f.clip,f.asset,f.probe)).toThrow(/ACES/);
  });
  it.each([0,-1,257,NaN])("refuses an invalid maximum dimension %s",value => {
    const f = fixture(); expect(() => shotGradeFramePlanV1(f.project,f.clip,f.asset,f.probe,value)).toThrow(/bounds/);
  });
  it("refuses oversized canvas and mismatched source identity",() => {
    const f = fixture();
    expect(() => shotGradeFramePlanV1({...f.project,width:8193},f.clip,f.asset,f.probe)).toThrow(/bounds/);
    expect(() => shotGradeFramePlanV1(f.project,{...f.clip,assetId:"other"},f.asset,f.probe)).toThrow(/stage/);
  });
});
describe("actual packed/planar RGBA unpacking",() => {
  it("copies packed eight-bit RGB and preserves transparent/partial alpha",() => {
    const raw = new Uint8Array([1,2,3,0,4,5,6,128]), result = unpackShotGradeWorkingPixelsV1(raw,2,1,false);
    expect([...result.rgb]).toEqual([1,2,3,4,5,6]); expect([...result.alpha]).toEqual([0,128]); expect(result.allPixelsOpaque).toBe(false);
    raw.fill(255); expect([...result.rgb]).toEqual([1,2,3,4,5,6]); expect([...result.alpha]).toEqual([0,128]);
  });
  it("reads little-endian G/B/R/A planes with a nonzero byte offset and no alpha quantization",() => {
    const allocation = new Uint8Array(20), raw = allocation.subarray(2,18), view = new DataView(raw.buffer,raw.byteOffset,raw.byteLength);
    [1000,1001,2000,2001,3000,3001,65535,65432].forEach((v,i) => view.setUint16(i*2,v,true));
    const result = unpackShotGradeWorkingPixelsV1(raw,2,1,true);
    expect([...result.rgb]).toEqual([3000,1000,2000,3001,1001,2001]);
    expect([...result.alpha]).toEqual([65535,65432]); expect(result.allPixelsOpaque).toBe(false);
  });
  it("distinguishes positive partial alpha from invisible pixels at the observed HDR readback code",() => {
    const raw = new Uint8Array([0,0,0,0,0,0,0,255]);
    const result = unpackShotGradeWorkingPixelsV1(raw,1,1,true);
    expect(result.allPixelsOpaque).toBe(false);
    expect([...result.alpha]).toEqual([65280]);
    expect(result.alphaCohort).toEqual({totalPixels:1,maximum:65535,zeroPixels:0,partialPixels:1,opaquePixels:0});
    const mixed = unpackShotGradeWorkingPixelsV1(new Uint8Array([1,2,3,0,4,5,6,128,7,8,9,255]),3,1,false);
    expect(mixed.alphaCohort).toEqual({totalPixels:3,maximum:255,zeroPixels:1,partialPixels:1,opaquePixels:1});
  });
  it("reports complete opacity only when every alpha code is the format maximum",() => {
    expect(unpackShotGradeWorkingPixelsV1(new Uint8Array([0,128,255,255]),1,1,false).allPixelsOpaque).toBe(true);
    const raw = new Uint8Array([0,0,0,0,0,0,255,255]);
    expect(unpackShotGradeWorkingPixelsV1(raw,1,1,true).allPixelsOpaque).toBe(true);
  });
  it.each([new Uint8Array(3),new Uint8Array(5),new Uint8Array(8)])("rejects wrong raw lengths (%s)",raw => {
    expect(() => unpackShotGradeWorkingPixelsV1(raw,1,1,false)).toThrow(/RGBA/);
  });
  it("refuses oversized and shared/resizable readback buffers",() => {
    expect(() => unpackShotGradeWorkingPixelsV1([0,0,0,255] as unknown as Uint8Array,1,1,false)).toThrow();
    expect(() => unpackShotGradeWorkingPixelsV1(new Uint8Array(4),257,1,false)).toThrow();
    expect(() => unpackShotGradeWorkingPixelsV1(new Uint8Array(new SharedArrayBuffer(4)),1,1,false)).toThrow();
    expect(() => unpackShotGradeWorkingPixelsV1(new Uint8Array(new ArrayBuffer(4,{maxByteLength:8})),1,1,false)).toThrow();
  });
});
