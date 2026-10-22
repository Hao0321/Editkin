import { describe,expect,it } from "vitest";
import { parseDecodedFrameClockV1,decodedPresentationWindowV1,verifyDecodedPresentationIdentityV1 } from "./decodedPresentationClockV1";
const frame=(pts:number,duration=512)=>({pts,bestEffortPts:pts,duration});
describe("decoded presentation clock constant-state proof",()=>{
 it("parses measured compact fields, optional empty side-data trailer and large ticks",()=>{
  expect(parseDecodedFrameClockV1("pts=4294967296|best_effort_timestamp=4294967296|duration=512|\r")).toEqual(frame(2**32));
  for(const bad of ["pts=0|best_effort_timestamp=512|duration=512","pts=0|best_effort_timestamp=0|duration=512|pts=0","pts=N/A|best_effort_timestamp=0|duration=512","pts=0|best_effort_timestamp=0|duration=512||"])expect(()=>parseDecodedFrameClockV1(bad)).toThrow();
 });
 it("matches full source selected window and output across rational container timebases",()=>{
  const s=decodedPresentationWindowV1(1024,2048,{numerator:1,denominator:1024},"source"),o=decodedPresentationWindowV1(0,4096,{numerator:1,denominator:4096},"output");
  for(let i=0;i<6;i++)s.accept(frame(i*512));o.accept(frame(0,2048));o.accept(frame(2048,2048));const source=s.finish(),output=o.finish();expect(verifyDecodedPresentationIdentityV1(source,output)).toMatchObject({presentedFrames:2,pixelIdentityStillRequired:true,rawGopDependencyProofStillRequired:true});expect(()=>verifyDecodedPresentationIdentityV1({...source,presentationTimelineSha256:"unknown"},{...output,presentationTimelineSha256:"unknown"})).toThrow("SHAPE_INVALID");
 });
 it("uses VFR next-PTS holds and one lookbehind without nominal frame-rate rounding",()=>{
  const s=decodedPresentationWindowV1(1000,2000,{numerator:1,denominator:1000},"source"),o=decodedPresentationWindowV1(0,1000,{numerator:1,denominator:1000},"output");
  s.accept(frame(0,123));s.accept(frame(1000,100));s.accept(frame(1250,750));o.accept(frame(0,7));o.accept(frame(250,750));expect(verifyDecodedPresentationIdentityV1(s.finish(),o.finish()).presentedFrames).toBe(2);
 });
 it("rejects the actual45-count substituted tail and stays failed after caller catches it",()=>{
  const w=decodedPresentationWindowV1(0,45*512,{numerator:1,denominator:15360},"output");for(let i=0;i<44;i++)w.accept(frame(i*512));expect(()=>w.accept(frame(45*512))).toThrow("EXTRA_OR_SUBSTITUTED");expect(()=>w.finish()).toThrow("EXTRA_OR_SUBSTITUTED");
  for(const bad of [frame(512),frame(-512)])expect(()=>decodedPresentationWindowV1(0,1024,{numerator:1,denominator:15360},"output").accept(bad)).toThrow();
  const duplicate=decodedPresentationWindowV1(0,1024,{numerator:1,denominator:15360},"output");duplicate.accept(frame(0));expect(()=>duplicate.accept(frame(0))).toThrow("ORDER");
 });
 it("requires exact end/start boundaries, detects EOF and preserves ticks above2^32",()=>{
  const missing=decodedPresentationWindowV1(0,1024,{numerator:1,denominator:15360},"output");missing.accept(frame(0));expect(()=>missing.finish()).toThrow("EOF");
  const mid=decodedPresentationWindowV1(100,1024,{numerator:1,denominator:15360},"source");mid.accept(frame(0));expect(()=>mid.accept(frame(512))).toThrow("START_NOT_EXACT");
  const big=decodedPresentationWindowV1(2**32,2**32+1024,{numerator:1,denominator:48000},"source");big.accept(frame(0));big.accept(frame(2**32));big.accept(frame(2**32+512));expect(big.finish()).toMatchObject({frames:2,startTicks:2**32});
 });
});
