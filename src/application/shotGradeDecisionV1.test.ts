import {expect,it} from "vitest";
import {shotGradeMatchRequestSchemaV1,shotGradeBalanceRequestSchemaV1,shotGradeCommandV1,assertShotGradeCommandV1} from "./shotGradeDecisionV1";
const binding={materialId:"a".repeat(64),semanticReceiptSha256:"b".repeat(64)};
const regions=[{sampleId:"frame",role:"neutral" as const,x:0,y:0,width:.5,height:1},{sampleId:"frame",role:"skin" as const,x:.5,y:0,width:.5,height:1}];
const match={target:binding,reference:{...binding,materialId:"c".repeat(64)},regions,referenceRegions:regions,roiBasis:"local-layer-raster-normalized" as const,reason:"Caller-declared technical reference"};
it("keeps complete explicit material/reference identities and a bounded sampling policy",()=>{
 expect(shotGradeMatchRequestSchemaV1.parse(match)).toMatchObject({...match,maximumFrames:2,highBitDepth:false,maximumTimeMs:20000});
 const {reference,referenceRegions,...balance}=match;expect(shotGradeBalanceRequestSchemaV1.parse(balance)).not.toHaveProperty("reference");
});
it.each([
 {...match,target:{...binding,materialId:"../outside"}},{...match,regions:[{...regions[0],x:.75}]},{...match,regions:[{...regions[0],width:0}]},
 {...match,regions:[{...regions[0],x:NaN}]},{...match,regions:[{...regions[0],role:"detected-skin"}]},{...match,regions:[{...regions[0],sampleId:"../pixel"}]},
 {...match,roiBasis:"source-upright"},{...match,maximumFrames:5},{...match,maximumFrames:1.5},{...match,maximumTimeMs:0},
 {...match,maximumTimeMs:120001},{...match,maximumTimeMs:Infinity},{...match,reason:" "},{...match,command:{type:"set_clip_grade_v2"}}
])("refuses unsafe or ambiguous proposal input %j",request=>expect(()=>shotGradeMatchRequestSchemaV1.parse(request)).toThrow());
it("copies an absolute grade command and requires exact identity",()=>{
 const grade={schema:"editkin.color-grade/v2" as const,nodes:[{id:"owned",gain:{master:.1}}]},command=shotGradeCommandV1("clip",grade);
 grade.nodes[0].gain.master=.2;expect(command.grade?.nodes?.[0].gain?.master).toBe(.1);
 expect(()=>assertShotGradeCommandV1(structuredClone(command),command)).not.toThrow();
});
it.each([
 {type:"set_clip_grade_v2",clipId:"other",grade:null},{type:"set_clip_grade_v2",clipId:"clip",grade:{schema:"editkin.color-grade/v2"}},
 {type:"set_clip_grade_v2",clipId:"clip",grade:null,extra:undefined},{type:"set_clip_color",clipId:"clip",patch:{}},{type:"batch",commands:[]}
])("refuses a substituted, patched or nested command %j",actual=>expect(()=>assertShotGradeCommandV1(actual,shotGradeCommandV1("clip",null))).toThrow(/Exact/));
it("cannot authorize a command from a non-applicable proposal",()=>expect(()=>assertShotGradeCommandV1(shotGradeCommandV1("clip",null),null)).toThrow(/applicable/));
