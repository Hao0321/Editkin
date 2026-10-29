import * as z from "zod/v4";

export const subjectStickerStyleV1Schema=z.strictObject({
  schema:z.literal("editkin.subject-sticker-style/v1"),borderPixels:z.number().int().min(0).max(32),
  shadowSigma:z.number().finite().min(0).max(16),shadowOpacity:z.number().finite().min(0).max(1),
  shadowOffsetX:z.number().int().min(-64).max(64),shadowOffsetY:z.number().int().min(-64).max(64),
  popStartFrame:z.number().int().nonnegative().max(20736000),popFrames:z.number().int().min(1).max(240),
  popStartScale:z.number().finite().min(.1).max(1),popOvershoot:z.number().finite().min(0).max(.2),
  anchorX:z.number().finite().min(0).max(1),anchorY:z.number().finite().min(0).max(1),
});
export type SubjectStickerStyleV1=z.infer<typeof subjectStickerStyleV1Schema>;
export function subjectStickerScaleV1(style:SubjectStickerStyleV1,frame:number):number{
  const s=subjectStickerStyleV1Schema.parse(style);if(!Number.isSafeInteger(frame)||frame<0||frame>20736000)throw Error("STICKER_FRAME_INVALID");
  const p=Math.max(0,Math.min(1,(frame-s.popStartFrame)/s.popFrames));return 1-(1-s.popStartScale)*(1-p)**3+s.popOvershoot*Math.sin(Math.PI*p)*(1-p);
}
const label=/^(?:\d+:v(?::\d+)?|[a-zA-Z][a-zA-Z0-9_]{0,63})$/;
function n(value:number){return value.toFixed(8).replace(/0+$/,'').replace(/\.$/,'')||'0';}
/**
 * Source is straight RGB. effectiveAlpha is same-size/rate, already sourceAlpha*the entire authored mask stack.
 * No source alpha extraction/multiplication here: soft source edges must be multiplied exactly once by the owner.
 */
export function buildSubjectStickerFiltersV1(input:{sourceRgbLabel:string;effectiveAlphaLabel:string;outputLabel:string;width:number;height:number;frameOffset:number;style:SubjectStickerStyleV1}){
  const{sourceRgbLabel:rgb,effectiveAlphaLabel:alpha,outputLabel:out,width:w,height:h,frameOffset}=input,s=subjectStickerStyleV1Schema.parse(input.style);
  if(![w,h].every(v=>Number.isSafeInteger(v)&&v>0&&v<=8192)||w*h>16777216||!Number.isSafeInteger(frameOffset)||frameOffset<0||frameOffset>20736000
    ||![rgb,alpha,out].every(v=>label.test(v))||new Set([rgb,alpha,out]).size!==3||!/^\w+$/.test(out)||rgb.startsWith(out+'S')||alpha.startsWith(out+'S'))throw Error("STICKER_GRAPH_INPUT_INVALID");
  const p=out+'S',f:string[]=[];
  f.push(`[${rgb}]format=rgb24[${p}rgb]`,`[${alpha}]format=gray,split=3[${p}fgA][${p}grow0][${p}ringSeed]`,`[${p}rgb][${p}fgA]alphamerge[${p}fg]`);
  for(let r=0;r<s.borderPixels;r++)f.push(`[${p}grow${r}]dilation=coordinates=255[${p}grow${r+1}]`);
  const grown=p+'grow'+s.borderPixels;
  if(s.shadowOpacity>0){
    f.push(`[${grown}]split[${p}borderSeed][${p}shadowSeed]`);
    const sx=`X-${s.shadowOffsetX}`,sy=`Y-${s.shadowOffsetY}`,inside=`gte(${sx},0)*lt(${sx},W)*gte(${sy},0)*lt(${sy},H)`;
    f.push(`[${p}shadowSeed]${s.shadowSigma>0?`gblur=sigma=${n(s.shadowSigma)},`:''}geq=lum='if(${inside},lum(${sx},${sy})*${n(s.shadowOpacity)},0)'[${p}shadowA]`);
    f.push(`[${p}shadowA]split[${p}blackSeed][${p}blackA]`,`[${p}blackSeed]format=rgb24,lutrgb=r=0:g=0:b=0[${p}black]`,`[${p}black][${p}blackA]alphamerge[${p}shadow]`);
  }else f.push(`[${grown}]null[${p}borderSeed]`);
  // Border is a ring beneath the subject, not a second copy of its soft alpha.
  // M + ring*(1-M) = grown; radius0 yields zero ring and the exact original foreground.
  f.push(`[${p}borderSeed][${p}ringSeed]blend=all_expr='if(lt(B,255),max(A-B,0)*255/(255-B),0)':shortest=1[${p}borderA]`);
  f.push(`[${p}borderA]split[${p}whiteSeed][${p}whiteA]`,`[${p}whiteSeed]format=rgb24,lutrgb=r=255:g=255:b=255[${p}white]`,`[${p}white][${p}whiteA]alphamerge[${p}border]`);
  const over=(a:string,b:string,c:string)=>`[${a}][${b}]overlay=x=0:y=0:alpha=straight:format=auto:shortest=1:repeatlast=0:eof_action=endall[${c}]`;
  if(s.shadowOpacity>0)f.push(over(p+'shadow',p+'border',p+'base'));else f.push(`[${p}border]null[${p}base]`);
  f.push(over(p+'base',p+'fg',p+'flat'));
  if(s.popStartScale===1&&s.popOvershoot===0){f.push(`[${p}flat]format=rgba[${out}]`);}
  else{
    const progress=`max(0,min(1,(N+${frameOffset}-${s.popStartFrame})/${s.popFrames}))`,scale=`(1-${n(1-s.popStartScale)}*pow(1-(${progress}),3)+${n(s.popOvershoot)}*sin(PI*(${progress}))*(1-(${progress})))`;
    const cx=n((w-1)*s.anchorX),cy=n((h-1)*s.anchorY),x=`((X-${cx})/${scale}+${cx})`,y=`((Y-${cy})/${scale}+${cy})`,inside=`gte(${x},0)*lte(${x},W-1)*gte(${y},0)*lte(${y},H-1)`;
    // Zero outside inverse-mapped canvas instead of geq's default edge clamping. Every channel has the same transform.
    f.push(`[${p}flat]format=gbrap,geq=r='r(${x},${y})':g='g(${x},${y})':b='b(${x},${y})':a='if(${inside},alpha(${x},${y}),0)':interpolation=bilinear,format=rgba[${out}]`);
  }
  return{schema:"editkin.subject-sticker-filter-plan/v1" as const,filters:f,outputLabel:out,width:w,height:h,
    alphaContract:"straight RGB + once-combined effective alpha; straight RGBA output" as const,morphology:"Chebyshev square neighbourhood maximum" as const,
    rasterReserveBytes:(24+s.borderPixels)*w*h*4,reserveBasis:"conservative filter-plane estimate, not measured FFmpeg RSS" as const,
    qualityState:"ART_PENDING_CLAUDE" as const,defaultEnabled:false as const};
}
