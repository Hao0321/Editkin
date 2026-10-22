import {beforeAll,expect,it} from "vitest";
import {readFile,writeFile} from "node:fs/promises";
import {createShotGradeFixtureV1} from "../test/shotGradeFixtureV1";
import {useTempRoots} from "../test/tempRoot.mjs";
import {readShotGradeRenderedFrameV1} from "./shotGradeRenderedFramesV1";
import {readShotGradeWorkingFrameV1,unpackShotGradeWorkingPixelsV1} from "./shotGradeFramesV1";
import {renderShotGradeSurfacesV1} from "../color/shotGradeCandidateV1";
import {compileClipAlphaPlan} from "../domain/clipAlphaPlan";
import {compositorVideoFilters,prepareCompositeGrades} from "../render/ffmpegComposite";
import {buildRenderPlan} from "../render/planner";
import {removeRenderWorkDirectory} from "../render/renderWorkspace";
import {inspectMedia} from "./inspectMedia";
import {runColorProcess,colorFileSha,colorDigest} from "./materialColorSamplingRuntime";
const temp=useTempRoots(),grade={schema:"editkin.color-grade/v2" as const,nodes:[{id:"nonlinear-order",gamma:{master:.23},contrast:1.18,saturation:.92}]};
let f:Awaited<ReturnType<typeof createShotGradeFixtureV1>>;
beforeAll(async()=>{f=await createShotGradeFixtureV1(temp,512,16,true);},120000);
it.each([false,true])("matches all codes of the unchanged full compositor with LUT before area sampling (16-bit %s)",async high=>{
 const project=structuredClone(f.project);project.tracks[0].clips[0].gradeV2=grade;
 const saved=structuredClone(project),result=await readShotGradeRenderedFrameV1(f.target.packet,project,0,f.source,f.runtime,60000,undefined,high);
 const plan=buildRenderPlan(project,uri=>uri),stages=await prepareCompositeGrades(project,plan,high);
 try{
  const clip=project.tracks[0].clips[0],asset=project.assets[0],probe=await inspectMedia(f.source,f.runtime.ffprobePath),format=high?"gbrap16le":"rgba",ordinal=Math.round(result.surface.sourceClock.decodedSourceTime*10);
  const graph=[...compositorVideoFilters({clip,asset,assetPath:f.source,probe,inputIndex:0,alphaPlan:compileClipAlphaPlan(project,clip,"formal")},"stage",plan,project,undefined,high,stages.stages.get(clip.id)),
   "[stage]select='eq(n,"+ordinal+")',scale=256:8:flags=area,format="+format+"[picked]"].join(";");
  const decoded=await runColorProcess(f.runtime.ffmpegPath,["-hide_banner","-loglevel","error","-nostdin","-threads","1","-filter_complex_threads","1","-i",f.source,"-filter_complex",graph,"-map","[picked]","-an","-frames:v","1","-fps_mode","passthrough","-pix_fmt",format,"-f","rawvideo","pipe:1"],256*256*(high?8:4));
  const expected=unpackShotGradeWorkingPixelsV1(decoded.stdout,256,8,high);
  expect(result.frame.pixels).toEqual(expected.rgb);expect(result.alpha).toEqual(expected.alpha);expect(project).toEqual(saved);
  const filters=result.surface.filters.join(",");expect(filters.indexOf("lut3d")).toBeLessThan(filters.indexOf("scale=256:8:flags=area"));
  expect(result.surface.finalOutputMeasured).toBe(false);expect(result.surface.sampling.order).toBe("after-primary-legacy-look-and-v2");
  expect(result.surface.projectSnapshotSha256).toBe(colorDigest(project));expect(await colorFileSha(f.source)).toBe(f.target.packet.source.sourceSha256);
 }finally{if(stages.workDirectory)await removeRenderWorkDirectory(stages.workDirectory);}
},60000);
it("proves nonlinear grade and area downsampling cannot be swapped",async()=>{
 const pre=await readShotGradeWorkingFrameV1(f.target.packet,f.project,0,f.source,f.runtime,30000);
 const actual=await readShotGradeRenderedFrameV1(f.target.packet,f.project,0,f.source,f.runtime,60000,grade);
 const swapped=renderShotGradeSurfacesV1([pre.frame],grade)[0];
 expect(actual.frame.pixels.some((value,index)=>value!==swapped.pixels[index])).toBe(true);
 expect(actual.surface.hashes.packedRgbSha256).not.toBe(pre.surface.hashes.packedRgbSha256);
},60000);
it("uses the actual identity bypass without manufacturing a new raster",async()=>{
 const pre=await readShotGradeWorkingFrameV1(f.target.packet,f.project,0,f.source,f.runtime,30000),after=await readShotGradeRenderedFrameV1(f.target.packet,f.project,0,f.source,f.runtime,30000,null);
 expect(after.frame.pixels).toEqual(pre.frame.pixels);expect(after.alpha).toEqual(pre.alpha);expect(after.surface.cube).toBeNull();expect(after.surface.identityGradeBypass).toBe(true);
},60000);
it("refuses altered content-addressed cube bytes",async()=>{
 const first=await readShotGradeRenderedFrameV1(f.target.packet,f.project,0,f.source,f.runtime,60000,grade),path=first.surface.cube!.path,bytes=await readFile(path);
 try{await writeFile(path,Buffer.concat([bytes,Buffer.from("\n# altered owned cube\n")]));await expect(readShotGradeRenderedFrameV1(f.target.packet,f.project,0,f.source,f.runtime,60000,grade)).rejects.toThrow(/cache bytes changed/);}
 finally{await writeFile(path,bytes);}
},60000);
it("refuses unsupported finishing, an invalid deadline and cancellation",async()=>{
 await expect(readShotGradeRenderedFrameV1(f.target.packet,f.project,0,f.source,f.runtime,30000,{schema:"editkin.color-grade/v2",finishing:{grain:{amount:.1}}})).rejects.toThrow(/Spatial/);
 await expect(readShotGradeRenderedFrameV1(f.target.packet,f.project,0,f.source,f.runtime,0)).rejects.toThrow(/budget/);
 const controller=new AbortController();controller.abort();await expect(readShotGradeRenderedFrameV1(f.target.packet,f.project,0,f.source,{...f.runtime,signal:controller.signal},30000)).rejects.toThrow();
});
