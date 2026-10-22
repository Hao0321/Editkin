import {beforeAll,expect,it} from "vitest";
import {readFile,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {createShotGradeFixtureV1} from "../test/shotGradeFixtureV1";
import {useTempRoots} from "../test/tempRoot.mjs";
import {colorDigest,colorFileSha} from "./materialColorSamplingRuntime";
import {canonicalJson} from "../shared/canonicalJson";
import {proposeShotColorMatchV1,proposeAutoBalanceV1,verifyShotGradeDecisionV1} from "./shotGradeEvidenceV1";
const temp=useTempRoots();
let f:Awaited<ReturnType<typeof createShotGradeFixtureV1>>,proposal:Awaited<ReturnType<typeof proposeShotColorMatchV1>>,receiptPath:string;
beforeAll(async()=>{f=await createShotGradeFixtureV1(temp);proposal=await proposeShotColorMatchV1(f.project,f.request,f.runtime);receiptPath=join(f.root,"shot-grade-decisions-v1",proposal.decisionSha256+".json");},120000);
it("issues a current, read-only proposal only after actual reference/baseline/candidate local pixels pass",async()=>{
 const saved=structuredClone(f.project);expect(proposal.applicable,proposal.reason).toBe(true);expect(proposal.command?.type).toBe("set_clip_grade_v2");expect(proposal.command?.clipId).toBe("target");
 expect(proposal.measurements.match?.matchesSpecifiedNeutralAndSkinBounds).toBe(true);expect(proposal.measurements.safety.measuredBoundsSatisfied).toBe(true);
 const receipt=JSON.parse(await readFile(receiptPath,"utf8"));expect(receipt.body.codeIdentity.implementations).toHaveLength(327);expect(receipt.body.primaryRuntimeIdentity.implementations).toHaveLength(33);
 expect(receipt.body.projectSnapshotSha256).toBe(colorDigest(f.project));expect(receipt.body.reference.clipId).toBe("reference");
 expect(receipt.body.surfaces.targetAfter.every((row:{stage:string})=>row.stage==="clip_working_post_v2")).toBe(true);
 expect(receipt.body.surfaces.reference.every((row:{stage:string})=>row.stage==="clip_working_post_v2")).toBe(true);
 expect(proposal.finalOutputMeasured).toBe(false);expect(proposal.vaContractAdmission).toBe(false);expect(f.project).toEqual(saved);
 await expect(verifyShotGradeDecisionV1(f.project,proposal.decisionSha256,proposal.command,f.runtime)).resolves.toMatchObject({clipId:"target",currentActualLocalPostGradeVerified:true,vaContractAdmission:false});
},60000);
it("reuses identical immutable receipt bytes rather than rewriting history",async()=>{
 const before=await readFile(receiptPath),again=await proposeShotColorMatchV1(f.project,f.request,f.runtime);
 expect(again.decisionSha256).toBe(proposal.decisionSha256);expect(await readFile(receiptPath)).toEqual(before);
},60000);
it("rejects substituted commands, revision, grade and ROI geometry",async()=>{
 await expect(verifyShotGradeDecisionV1(f.project,proposal.decisionSha256,{...proposal.command,clipId:"reference"},f.runtime)).rejects.toThrow(/Exact/);
 for(const mutate of [(p:typeof f.project)=>p.revision++,(p:typeof f.project)=>p.tracks[0].clips[0].color.exposure=.1,(p:typeof f.project)=>p.tracks[0].clips[1].gradeV2!.nodes![0].gain!.master=.2]){
  const project=structuredClone(f.project);mutate(project);await expect(verifyShotGradeDecisionV1(project,proposal.decisionSha256,proposal.command,f.runtime)).rejects.toThrow(/Project/);
 }
 await expect(proposeShotColorMatchV1(f.project,{...f.request,regions:f.request.regions.map(row=>({...row,sampleId:"not-a-measured-frame"}))},f.runtime)).rejects.toThrow(/region/i);
},60000);
it.each(["target","reference"])("rejects actual %s source drift",async mode=>{
 const path=mode==="target"?f.source:f.referenceSource,bytes=await readFile(path);
 try{await writeFile(path,Buffer.concat([bytes,Buffer.from([0])]));await expect(verifyShotGradeDecisionV1(f.project,proposal.decisionSha256,proposal.command,f.runtime)).rejects.toThrow();}
 finally{await writeFile(path,bytes);}
 expect(await colorFileSha(path)).toBe(f.target.packet.source.sourceSha256);
},60000);
it("rejects a rehashed forged grade decision by independently remeasuring",async()=>{
 const receipt=JSON.parse(await readFile(receiptPath,"utf8"));receipt.body.command.grade={schema:"editkin.color-grade/v2",nodes:[{id:"forged",gain:{master:.2}}]};
 const id=colorDigest({schema:receipt.schema,body:receipt.body});receipt.decisionSha256=id;
 await writeFile(join(f.root,"shot-grade-decisions-v1",id+".json"),canonicalJson(receipt)+"\n");
 await expect(verifyShotGradeDecisionV1(f.project,id,receipt.body.command,f.runtime)).rejects.toThrow(/Current/);
},60000);
it("requires both current semantic bindings and refuses alpha/unsupported context",async()=>{
 await expect(proposeShotColorMatchV1(f.project,{...f.request,reference:{...f.request.reference,semanticReceiptSha256:"0".repeat(64)}},f.runtime)).rejects.toThrow();
 const project=structuredClone(f.project);project.width*=2;
 await expect(proposeShotColorMatchV1(project,f.request,f.runtime)).rejects.toThrow(/Alpha cohort/);
},60000);
it("observes cancellation, elapsed budget and a project changed during an await",async()=>{
 const controller=new AbortController();controller.abort();await expect(proposeShotColorMatchV1(f.project,f.request,{...f.runtime,signal:controller.signal})).rejects.toThrow();
 await expect(proposeShotColorMatchV1(f.project,{...f.request,maximumTimeMs:Number.MIN_VALUE},f.runtime)).rejects.toThrow(/budget/);
 const project=structuredClone(f.project);await expect(proposeShotColorMatchV1(project,f.request,{...f.runtime,resolveSource:async id=>{project.revision++;return f.runtime.resolveSource(id);}})).rejects.toThrow(/Project changed/);
},60000);
it("proposes neutral auto balance without inventing a reference shot or white classification",async()=>{
 const {reference,referenceRegions,...request}=f.request,result=await proposeAutoBalanceV1(f.project,request,f.runtime);
 expect(result.applicable,result.reason).toBe(true);expect(result.status).toBe("unchanged");expect(result.measurements.neutrality!.afterCie00).toBeLessThanOrEqual(3);
 const receipt=JSON.parse(await readFile(join(f.root,"shot-grade-decisions-v1",result.decisionSha256+".json"),"utf8"));expect(receipt.body.reference).toBeNull();expect(receipt.body.numericalEvaluation.whitePointClassified).toBe(false);expect(receipt.body.command.grade).toBeNull();
},60000);
