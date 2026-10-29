import type { EditProject } from "../domain/types";
import type { MediaProbe } from "./ffmpegTypes";
import { compileClipAlphaPlan } from "../domain/clipAlphaPlan";
import { buildRenderPlan } from "./planner";
import { compositorVideoFilters, overlayPositionedFilter } from "./ffmpegComposite";
import { compositeFrameClock } from "./compositeFrameClock";
import { animatedGeometryCanvas } from "./animatedGeometryCanvas";
import { finite } from "./ffmpegExpressions";
function tokens(chain:string){
  const values:string[]=[];let quote=false,escape=false,start=0;
  for(let i=0;i<chain.length;i++){const c=chain[i];if(escape){escape=false;continue;}if(c==='\\'){escape=true;continue;}
    if(c==="'"){quote=!quote;continue;}if(c===','&&!quote){values.push(chain.slice(start,i));start=i+1;}}
  if(quote||escape)throw Error("UI_FOCUS_GEOMETRY_GRAPH_SYNTAX");values.push(chain.slice(start));return values;
}
/** A new internal observational route calls the actual unchanged formal helper.
 * It does not intercept child arguments or alter the formal render path. */
export function longformUiFocusGeometryGraphV1(projectInput:EditProject,clipId:string,sourcePath:string,probe:MediaProbe,
  normalizationFilters:readonly string[]){
  const project=structuredClone(projectInput),track=project.tracks.find(t=>t.clips.some(c=>c.id===clipId)),clip=track?.clips.find(c=>c.id===clipId);
  const asset=project.assets.find(a=>a.id===clip?.assetId);
  if(!clip||!asset||asset.kind!=='video'||track?.kind!=='video'||track.hidden||clip.layer?.enabled===false)
    throw Error("UI_FOCUS_GEOMETRY_GRAPH_VISIBLE_SOURCE");
  if(project.scene25d?.enabled||project.scene3d||clip.transform3d||clip.floatingFrame||clip.masks?.some(m=>m.enabled)
    ||clip.chromaKey?.enabled||clip.layer?.trackMatte||['controller','adjustment'].includes(clip.layer?.role??'content')
    ||clip.creative?.transitionIn||clip.creative?.transitionOut||clip.creative?.effectPresetIds?.length||clip.creative?.nativeEffectInstances?.length)
    throw Error("UI_FOCUS_GEOMETRY_GRAPH_UNSUPPORTED_ROUTE");
  // Prepared LUT/spatial/ACES and floating routes need their own real renderer
  // integration. Never omit a grade and describe the result as the full project.
  if(clip.gradeV2||clip.creative?.lookPresetId||project.colorManagement?.mode==='aces2'
    ||asset.color?.interpretation&&asset.color.interpretation!=='rec709')throw Error("UI_FOCUS_GEOMETRY_GRAPH_COLOR_ROUTE");
  if(!probe.hasVideo||!probe.width||!probe.height||!normalizationFilters.length||normalizationFilters.join(',').length>65536)
    throw Error("UI_FOCUS_GEOMETRY_GRAPH_SOURCE");
  const plan=buildRenderPlan(project,()=>sourcePath),alphaPlan=compileClipAlphaPlan(project,clip,'formal');
  const chains=compositorVideoFilters({clip,asset,assetPath:sourcePath,probe,alphaPlan,inputIndex:0},'uif_video',plan,project);
  if(chains.length!==1||!chains[0].startsWith('[0:v]scale=')||!chains[0].endsWith('[uif_video]'))throw Error("UI_FOCUS_GEOMETRY_GRAPH_FORMAL_CHAIN");
  const original=chains[0],parts=tokens(original.slice(0,-'[uif_video]'.length).replace('[0:v]','[uif_source_geometry]')),output:string[]=[];
  let input=false,scaled=false,affine=false,layout=false;
  const add=(stage:string)=>output.push('showinfo@uif_'+stage);
  for(const [i,part]of parts.entries()){
    const scale=/^scale='iw\*/.test(part),rotate=/^rotate=/.test(part),perspective=/^perspective=/.test(part);
    if(scale||rotate||perspective){if(!input){add('input');input=true;}if(!scale&&!scaled){add('scaled');scaled=true;}}
    if(/^settb=/.test(part)&&!input){add('input');add('scaled');add('output');input=scaled=affine=true;}
    output.push(part);if(i===0)add('fit');
    if(/^trim=/.test(part)){add('clock');if(!clip.layout){add('layout');layout=true;}}
    if(clip.layout&&/^scale=\d+:\d+:flags=lanczos$/.test(part)){add('layout');layout=true;}
    if(scale){add('scaled');scaled=true;if(!parts.slice(i+1).some(v=>/^rotate=/.test(v))){add('output');affine=true;}}
    if(rotate||perspective){add('output');affine=true;}
  }
  if(!input||!scaled||!affine||!layout)throw Error("UI_FOCUS_GEOMETRY_GRAPH_STAGE_COVERAGE");add('position');
  const clock=compositeFrameClock(project.fps,clip.timelineStart),[denominator,numerator]=clock.rate.split('/').map(Number);
  const sourceClock=[...normalizationFilters,'format=gray','showinfo@clock_input',`fps@clock_rate=${clock.rate}`,
    `trim=duration=${finite(clip.duration)}`,clock.timestampFilters,'showinfo@clock_output'];
  const originalPlacement=overlayPositionedFilter('uif_base','uif_video','uif_project',clip,plan,project);
  const graph=['[0:v]split=2[uif_source_clock][uif_source_geometry]',
    '[uif_source_clock]'+sourceClock.join(',')+'[uif_gray]',output.join(',')+'[uif_video]',
    `[1:v]format=rgba,${clock.timestampFilters}[uif_base]`,originalPlacement.replace('overlay=','overlay@uif_place=')].join(';');
  return{graph,originalChain:original,originalPlacement,rate:clock.rate,startFrame:clock.startFrame,
    projectTimeBase:{numerator,denominator},mode:animatedGeometryCanvas(project,clip,plan.width,plan.height)?'fixed-perspective' as const:'scale-rotate' as const,
    sourceInputArgs:['-ss',finite(clip.sourceStart),'-t',finite(clip.duration),'-i',sourcePath],
    baseInputArgs:['-f','lavfi','-i',`color=c=black:s=${project.width}x${project.height}:r=${clock.rate}:d=${finite(clip.duration)}`]};
}
