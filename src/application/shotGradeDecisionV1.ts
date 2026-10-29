import * as z from "zod/v4";
import {canonicalJson} from "../shared/canonicalJson";
import type {EditorCommand} from "../domain/commands";
import type {ColorGradeV2} from "../domain/visualTypes";
export const shotGradeMaterialBindingSchemaV1=z.strictObject({materialId:z.string().regex(/^[a-f0-9]{64}$/),semanticReceiptSha256:z.string().regex(/^[a-f0-9]{64}$/)});
export const shotGradeRegionSchemaV1=z.strictObject({sampleId:z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),role:z.enum(["neutral","skin","food","sky"]),
 x:z.number().finite().min(0).max(1),y:z.number().finite().min(0).max(1),width:z.number().finite().gt(0).max(1),height:z.number().finite().gt(0).max(1)})
 .refine(r=>r.x+r.width<=1&&r.y+r.height<=1,"Region must stay within the local layer raster");
const common={target:shotGradeMaterialBindingSchemaV1,regions:z.array(shotGradeRegionSchemaV1).min(2).max(32),
 roiBasis:z.literal("local-layer-raster-normalized"),reason:z.string().trim().min(1).max(500),
 maximumFrames:z.number().int().min(1).max(4).default(2),highBitDepth:z.boolean().default(false),maximumTimeMs:z.number().finite().gt(0).max(120000).default(20000)};
export const shotGradeMatchRequestSchemaV1=z.strictObject({...common,reference:shotGradeMaterialBindingSchemaV1,referenceRegions:z.array(shotGradeRegionSchemaV1).min(2).max(32)});
export const shotGradeBalanceRequestSchemaV1=z.strictObject(common);
export type ShotGradeMatchRequestV1=z.input<typeof shotGradeMatchRequestSchemaV1>;
export type ShotGradeBalanceRequestV1=z.input<typeof shotGradeBalanceRequestSchemaV1>;
export type ParsedShotGradeRequestV1=z.output<typeof shotGradeMatchRequestSchemaV1>|z.output<typeof shotGradeBalanceRequestSchemaV1>;
export function shotGradeCommandV1(clipId:string,grade:ColorGradeV2|null):Extract<EditorCommand,{type:"set_clip_grade_v2"}>{return {type:"set_clip_grade_v2",clipId,grade:structuredClone(grade)};}
/** An absolute, complete grade command. Never accept a patch, nested batch,
 * caller-added keys, alternate target, or an unbound decision command. */
export function assertShotGradeCommandV1(actual:unknown,expected:Extract<EditorCommand,{type:"set_clip_grade_v2"}>|null){
 if(expected===null||!actual||typeof actual!=="object"||Array.isArray(actual)||Object.keys(actual).sort().join("|")!=="clipId|grade|type"
  ||canonicalJson(actual)!==canonicalJson(expected))throw Error("SHOT_GRADE_DECISION_INVALID: Exact applicable grade command required");
}
