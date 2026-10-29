import {beforeAll,expect,it} from "vitest";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {readFile,writeFile} from "node:fs/promises";
import {createEmptyProject} from "../domain/editGraph";
import {DEFAULT_COLOR,DEFAULT_TRANSFORM,type EditProject} from "../domain/types";
import {compileClipAlphaPlan} from "../domain/clipAlphaPlan";
import {compositorVideoFilters} from "../render/ffmpegComposite";
import {buildRenderPlan} from "../render/planner";
import {sampleMaterialColor} from "./materialColorSampling";
import {colorDigest,colorFileSha,runColorProcess} from "./materialColorSamplingRuntime";
import type {MaterialIntelligencePacket} from "./materialIntelligence";
import {readShotGradeWorkingFrameV1,unpackShotGradeWorkingPixelsV1} from "./shotGradeFramesV1";
import {REPO_TMP,useTempRoots} from "../test/tempRoot.mjs";

const app = fileURLToPath(new URL("../../",import.meta.url)), temp = useTempRoots();
const runtime = {ffmpegPath:join(app,"vendor/ffmpeg/win32-x64/ffmpeg.exe"),ffprobePath:join(app,"vendor/ffmpeg/win32-x64/ffprobe.exe")};
let source:string, packet:MaterialIntelligencePacket, project:EditProject;
const probe = {hasVideo:true,hasAudio:false,duration:.8,width:48,height:32,encodedWidth:48,encodedHeight:32,
  sampleAspectRatio:2,colorPrimaries:"bt709",colorTransfer:"bt709",colorMatrix:"bt709",colorRange:"tv",pixelFormat:"yuv444p"};
beforeAll(async () => {
  const root = await temp.create("shot-grade-frame-render-",{parent:REPO_TMP}); source = join(root,"clock-and-sar.mp4");
  await runColorProcess(runtime.ffmpegPath,["-hide_banner","-loglevel","error","-nostdin","-threads","1","-filter_threads","1",
    "-f","lavfi","-i","testsrc=size=48x32:rate=10:duration=0.8,setsar=2/1,format=yuv444p","-an","-c:v","libx264","-preset","ultrafast","-qp","0",
    "-x264-params","colorprim=bt709:transfer=bt709:colormatrix=bt709:range=tv",source],4096);
  const sourceSha256 = await colorFileSha(source);
  const color = await sampleMaterialColor({sourcePath:source,sourceSha256,sourceStart:0,duration:.6,kind:"video",
    color:{interpretation:"rec709"},samples:[{id:"p",time:.2,sceneIndex:0}],sceneCount:1},runtime);
  expect(color.status,color.status === "measured" ? "measured" : color.reason).toBe("measured");
  project = createEmptyProject("Source-stage parity",{width:96,height:64,fps:10});
  project.assets.push({id:"a",name:"Owned technical clock/SAR fixture",uri:source,kind:"video",duration:.8,
    width:48,height:32,displayAspectRatio:3,color:{interpretation:"rec709"}});
  project.tracks[0].clips.push({id:"c",assetId:"a",trackId:project.tracks[0].id,timelineStart:.8,sourceStart:0,duration:.6,volume:0,
    transform:{...DEFAULT_TRANSFORM},color:{...DEFAULT_COLOR},keyframes:[]});
  packet = {schema:"hao.editkin.material-intelligence/v1",materialId:colorDigest({sourceSha256,fixture:"stage"}),
    source:{assetId:"a",clipId:"c",sourceSha256,sourceStart:0,duration:.6,kind:"video",width:48,height:32,fps:10,hasAudio:false,color:{interpretation:"rec709"}},
    analysis:{color,scene:{state:"ready",cuts:[]},transcript:{state:"not_applicable",cueCount:0,cues:[]}},keyframes:[],createdAt:new Date().toISOString()};
});

/** Independent, unchanged public compositor graph, with its actual fps/trim,
 * padding, associated-alpha crop, primary and legacy look. Select its source
 * frame by ordinal; do not reuse the new adapter's filter strings as the oracle.
 */
async function actualGraphFrame(value:EditProject,highBitDepth:boolean) {
  const clip = value.tracks[0].clips[0], asset = value.assets[0], plan = buildRenderPlan(value,uri => uri);
  const chains = compositorVideoFilters({clip,asset,assetPath:source,probe,inputIndex:0,
    alphaPlan:compileClipAlphaPlan(value,clip,"formal")},"stage",plan,value,undefined,highBitDepth);
  const format = highBitDepth ? "gbrap16le" : "rgba";
  const graph = [...chains,`[stage]select='eq(n,2)',format=${format}[picked]`].join(";");
  const output = await runColorProcess(runtime.ffmpegPath,["-hide_banner","-loglevel","info","-nostdin","-threads","1","-filter_complex_threads","1",
    "-i",source,"-filter_complex",graph,"-map","[picked]","-an","-frames:v","1","-fps_mode","passthrough",
    "-pix_fmt",format,"-f","rawvideo","pipe:1"],256*256*(highBitDepth ? 8 : 4));
  return output.stdout;
}
it.each([false,true])("matches every RGB/alpha code of the real public graph (high bit depth %s)",async highBitDepth => {
  const before = structuredClone(project), result = await readShotGradeWorkingFrameV1(packet,project,0,source,runtime,30000,highBitDepth);
  const raw = await actualGraphFrame(project,highBitDepth), expected = unpackShotGradeWorkingPixelsV1(raw,96,64,highBitDepth);
  expect(result.frame.pixels).toEqual(expected.rgb); expect(result.alpha).toEqual(expected.alpha);
  expect(result.allPixelsOpaque).toBe(false);
  expect([...result.alpha].filter(v => v === 0).length).toBeGreaterThan(0);
  expect(result.surface.sourceClock.decodedSourceTime).toBe(.2);
  expect(result.surface.sourceClock.decodedRelativeTime).toBe(.2);
  const clock = result.surface.sourceClock;
  expect(clock.pts*clock.timeBase.numerator/clock.timeBase.denominator-clock.timelineOrigin).toBe(.2);
  expect(result.surface).toMatchObject({scope:"actual-source-clock-local-clip-before-v2",allPixelsOpaque:false,
    fullRgbRasterIncludesInvisiblePixels:true,statisticsCohortStatus:"requires-alpha-cohort-adapter",
    implementationIdentityBound:false,decisionEvidenceBound:false});
  expect(result.surface.source.beforeSha256).toBe(result.surface.source.afterSha256);
  expect(result.surface.projectSnapshotSha256).toBe(colorDigest(project)); expect(project).toEqual(before);
});
it("captures associated-alpha crop, nonzero primary and legacy look exactly before gradeV2",async () => {
  const value = structuredClone(project), clip = value.tracks[0].clips[0];
  clip.layout = {crop:{x:0,y:.25,width:1,height:.5},viewport:{x:0,y:0,width:.75,height:.5}};
  clip.color = {...DEFAULT_COLOR,exposure:.15,shadows:.05,hue:2};
  clip.creative = {lookPresetId:"cinematic_warm_soft",effectPresetIds:[]};
  clip.gradeV2 = {schema:"editkin.color-grade/v2",nodes:[{id:"must-not-enter-pre-grade",gain:{master:.3}}]};
  const result = await readShotGradeWorkingFrameV1(packet,value,0,source,runtime,30000);
  const raw = await actualGraphFrame(value,false), expected = unpackShotGradeWorkingPixelsV1(raw,72,32,false);
  expect(result.frame.pixels).toEqual(expected.rgb); expect(result.alpha).toEqual(expected.alpha);
  expect(result.allPixelsOpaque).toBe(true);
  expect(result.alphaCohort).toEqual({totalPixels:2304,maximum:255,zeroPixels:0,partialPixels:0,opaquePixels:2304});
  expect(result.surface).toMatchObject({fullRgbRasterIncludesInvisiblePixels:false,statisticsCohortStatus:"opaque-all-pixels"});
  expect(result.surface.plan.geometry).toMatchObject({layerWidth:72,layerHeight:32,roiBasis:"pre-grade-layer-raster-normalized"});
  expect(result.surface.plan.filters.join(",")).not.toContain("lut3d");
});
it("refuses changed source bytes, current clip windows and cancellation",async () => {
  const original = await readFile(source);
  try {
    await writeFile(source,Buffer.concat([original,Buffer.from("owned drift control")]));
    await expect(readShotGradeWorkingFrameV1(packet,project,0,source,runtime,30000)).rejects.toThrow(/Source SHA/);
  } finally { await writeFile(source,original); }
  const altered = structuredClone(project); altered.tracks[0].clips[0].sourceStart = .1;
  await expect(readShotGradeWorkingFrameV1(packet,altered,0,source,runtime,30000)).rejects.toThrow(/window mismatch/);
  const abort = new AbortController(); abort.abort();
  await expect(readShotGradeWorkingFrameV1(packet,project,0,source,{...runtime,signal:abort.signal},30000)).rejects.toThrow();
});
it("refuses a self-consistent declared time that the actual decoder cannot produce",async () => {
  const changed = structuredClone(packet), receipt = changed.analysis.color!;
  if (receipt.status !== "measured") throw Error("Measured fixture required");
  receipt.request.samples[0].time = .25;
  Object.assign(receipt.mapping[0],{requestedTime:.25,decodedPts:25,timeBase:{numerator:1,denominator:100},decodedSourceTime:.25,decodedRelativeTime:.25});
  receipt.measurements.frames[0].timeSeconds = .25;
  receipt.receiptSha256 = colorDigest({...receipt,receiptSha256:undefined});
  await expect(readShotGradeWorkingFrameV1(changed,project,0,source,runtime,30000)).rejects.toThrow(/does not match measured source sample/);
});
it("enforces elapsed sampling budget and valid packet sample indexes",async () => {
  await expect(readShotGradeWorkingFrameV1(packet,project,0,source,runtime,.001)).rejects.toThrow(/budget/);
  await expect(readShotGradeWorkingFrameV1(packet,project,1,source,runtime,30000)).rejects.toThrow(/measured sample/);
  await expect(readShotGradeWorkingFrameV1(packet,project,0,"relative.mp4",runtime,30000)).rejects.toThrow(/source\/budget/);
});
