import * as z from "zod/v4";

export const LONGFORM70_RECIPE_IDS_V1=["number-hook","contrast-claim","relationship","recap-left","recap-right","recap-ink","domain-cta","invitation"]as const;
const frame=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),id=z.string().trim().min(1).max(80);
const evidence=z.array(z.string().trim().min(1).max(160)).min(1).max(8);
const binding=z.strictObject({text:z.string().min(1).max(256).refine(text=>text===text.trim()&&!/[\r\n]/u.test(text)&&[...text].length<=128,"Use exact one-line copy, at most128 characters"),
  startFrame:frame,endFrame:frame,readingHoldFrames:z.number().int().min(24).max(1800).default(24),
  minimumFontSize:z.number().int().min(8).max(384).optional(),evidenceRefs:evidence});
export const longform70NativeSceneRequestV1Schema=z.strictObject({schema:z.literal("editkin.longform70-native-scene-request/v1"),
  expectedRevision:frame,sceneId:z.string().regex(/^[a-z0-9][a-z0-9._-]{0,39}$/i),recipeId:z.enum(LONGFORM70_RECIPE_IDS_V1),startFrame:frame,endFrame:frame,
  scope:z.enum(["existing_timeline","empty_canvas"]),bindings:z.record(id,binding),evidenceRefs:evidence,
  palette:z.strictObject({primary:z.string().regex(/^#[a-f0-9]{6}$/i),background:z.string().regex(/^#[a-f0-9]{6}$/i),
    ink:z.string().regex(/^#[a-f0-9]{6}$/i),grid:z.string().regex(/^#[a-f0-9]{6}$/i)}).optional(),
}).superRefine((value,ctx)=>{
  if(value.endFrame<=value.startFrame||value.endFrame-value.startFrame>1800)ctx.addIssue({code:"custom",message:"Scene must span1..1800 frames"});
  for(const[name,cue]of Object.entries(value.bindings))if(cue.startFrame<value.startFrame||cue.endFrame>value.endFrame||cue.endFrame<=cue.startFrame)
    ctx.addIssue({code:"custom",path:["bindings",name],message:"Binding timing must remain inside the new narration scene"});
});
export type Longform70NativeSceneRequestV1=z.infer<typeof longform70NativeSceneRequestV1Schema>;
