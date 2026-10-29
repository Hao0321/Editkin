import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { assertLongformIntakeCurrentV1, prepareLongformMaterialIntakeV1, type LongformIntakeRuntimeV1 } from "./longformMaterialIntakeV1";

const owned: string[] = [];
afterEach(async () => { for (const root of owned.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "longword-intake-")); owned.push(root);
  for (const name of ["voice.wav", "screen.mp4", "proof.png"]) await writeFile(join(root,name), name);
  await writeFile(join(root,"script.txt"), "First paragraph.\n\n第二段。", "utf8");
  const request = { schema:"editkin.longform-word-timing-request/v1", narration:{id:"voice",path:"voice.wav",sourceStart:1,duration:4},
    script:{kind:"file",path:"script.txt"}, recordings:[{id:"screen",path:"screen.mp4",sourceStart:2,duration:5}],
    screenshots:[{id:"proof",path:"proof.png"}],language:"en" };
  const probe: NonNullable<LongformIntakeRuntimeV1["probe"]> = async () => ({duration:10,width:1920,height:1080,fps:30,hasAudio:true,hasVideo:true});
  return { root, request, probe };
}
it("reads script/material identities and caller ranges without changing their bytes", async () => {
  const {root,request,probe}=await fixture(); const before=await readFile(join(root,"script.txt"));
  const intake=await prepareLongformMaterialIntakeV1(request,{sourceRoot:root,probe});
  expect(intake.script.paragraphs.map(row=>row.text)).toEqual(["First paragraph.","第二段。"]);
  expect(intake.materials.map(row=>[row.kind,row.sourceStart,row.duration])).toEqual([["narration",1,4],["recording",2,5],["screenshot",0,0]]);
  expect(await readFile(join(root,"script.txt"))).toEqual(before);
  await expect(assertLongformIntakeCurrentV1(intake)).resolves.toBeUndefined();
});
it("detects a source replacement during intake and a later author script edit",async()=>{
  const {root,request,probe}=await fixture();
  await expect(prepareLongformMaterialIntakeV1(request,{sourceRoot:root,probe:async(path,...rest)=>{
    if(path.endsWith("voice.wav"))await writeFile(path,"different source");return probe(path,...rest);
  }})).rejects.toThrow("LONGFORM_SOURCE_CHANGED");
  const intake=await prepareLongformMaterialIntakeV1(request,{sourceRoot:root,probe});
  await writeFile(join(root,"script.txt"),"author edit");
  await expect(assertLongformIntakeCurrentV1(intake)).rejects.toThrow("LONGFORM_SCRIPT_CHANGED");
});
it("refuses out-of-range media, wrong fingerprints and an out-of-workspace script",async()=>{
  const {root,request,probe}=await fixture();
  await expect(prepareLongformMaterialIntakeV1({...request,narration:{...request.narration,duration:20}},{sourceRoot:root,probe})).rejects.toThrow("LONGFORM_SOURCE_RANGE");
  await expect(prepareLongformMaterialIntakeV1({...request,narration:{...request.narration,expectedSha256:"0".repeat(64)}},{sourceRoot:root,probe})).rejects.toThrow("LONGFORM_SOURCE_SHA_MISMATCH");
  const outside=await mkdtemp(join(tmpdir(),"longword-outside-"));owned.push(outside);await writeFile(join(outside,"script.txt"),"private");
  await expect(prepareLongformMaterialIntakeV1({...request,script:{kind:"file",path:join(outside,"script.txt")}},{sourceRoot:root,probe})).rejects.toThrow("LONGFORM_SOURCE_BOUNDARY");
});
it("propagates cancellation and rejects missing narration audio without publishing results",async()=>{
  const {root,request,probe}=await fixture();const stop=new AbortController();stop.abort();
  await expect(prepareLongformMaterialIntakeV1(request,{sourceRoot:root,probe,signal:stop.signal})).rejects.toMatchObject({name:"AbortError"});
  await expect(prepareLongformMaterialIntakeV1(request,{sourceRoot:root,probe:async(...args)=>({...await probe(...args),hasAudio:false})})).rejects.toThrow("LONGFORM_NARRATION_AUDIO_MISSING");
});
