import {beforeAll, describe, expect, it} from 'vitest';
import {readFile, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {isValidElement, type ReactNode, type ReactElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createEmptyProject} from '../domain/editGraph';
import {applyCommand} from '../domain/commands';
import {projectSchema} from '../domain/schema';
import {assertMotionGraphicV2Contract} from '../domain/motionCompositionV2Contract';
import {prepareGlyphRun, type PreparedGlyphRun} from '../typography/preparedGlyphRun';
import {bundledFontFaceSpec} from '../typography/bundledFontCatalog';
import {motionGraphicV2FrameReceipt,motionGraphicV2PhysicalLayoutReceipt} from '../motion/compositionV2';
import {writeAssContent} from '../render/captionAss';
import {canonicalJson} from '../shared/canonicalJson';
import {prepareOriginalMotionScene2d,originalMotionScene2dInputSchema,type OriginalMotionScene2dInput} from './originalMotionScene2d';
import {prepareOriginalSceneGraphicRevision} from './originalSceneGraphicRevision';
import {assertScopedMotionReadingHold} from './scopedMotionRevision';
import {compactAutopilotContract} from './autopilotPlan';
import MotionTextLayoutControls from '../ui/MotionTextLayoutControls';
import {SavedOriginalMotionScenes} from '../ui/SavedOriginalMotionScenes';

let run: PreparedGlyphRun;
beforeAll(async()=>{const spec=bundledFontFaceSpec('EditkinFace-noto-sans-tc-700');run=await prepareGlyphRun(spec.faceId,'我的作品',new Uint8Array(await readFile(resolve('public/fonts',spec.fontFile))));});
const deps={prepareText:async()=>run};
function fixture(frames=60, together=true){
 const project=projectSchema.parse(createEmptyProject('Whole sentence',{width:1920,height:1080,fps:30}));
 const input:OriginalMotionScene2dInput={expectedRevision:project.revision,sceneId:'whole-exit',intent:'standalone_showcase',reason:'Calibrated actual physical sentence with character entrance and independently timed exit',startFrame:0,durationFrames:frames,safeArea:{left:96,right:96,top:96,bottom:96},style:{palette:{surface:'#FFFFFF',text:'#172033',accent:'#175CD3',muted:'#5B6678',separator:'#D8DEE8'},typography:{headingFamily:'Noto Sans TC',bodyFamily:'Noto Sans TC'},animationSpeed:1},camera:{initial:{centerX:960,centerY:540,zoom:1},dynamics:{stiffness:120,damping:24,mass:1}},elements:[{id:'whole-title',kind:'text',text:'我的作品',typographyRole:'heading',fontWeight:700,fontSize:80,minFontSize:80,maxLines:1,lineGapPixels:0,letterSpacingPixels:0,xPixels:240,yPixels:360,widthPixels:1200,colorRole:'text',range:{startFrame:0,endFrame:frames},motionV2:{sequence:{unit:'character',order:'forward',exitOrder:'forward',staggerFrames:2,...(together?{exitStaggerFrames:0}:{})},entrance:{durationFrames:8,offsetXPixels:0,offsetYPixels:24,scale:1,opacity:0,easing:{type:'linear'}},exit:{durationFrames:8,offsetXPixels:0,offsetYPixels:-12,scale:1,opacity:0,easing:{type:'linear'}}}}],semanticCues:[{id:'whole-cue',frame:0,purpose:'One complete sentence remains readable until a synchronized exit',graphicIds:['whole-title'],evidenceRefs:['test:physical-sentence']}]};
 return {project,input};
}
async function prepared(together=true,frames=60){const f=fixture(frames,together);const packet=await prepareOriginalMotionScene2d(f.project,f.input,undefined,deps);const project=applyCommand(f.project,{type:'batch',commands:packet.commands});const graphic=project.motionGraphics[0];const layout=motionGraphicV2PhysicalLayoutReceipt(project,graphic,run);return {project,graphic,layout,packet,input:f.input};}
function select(node:ReactNode,label:string):ReactElement<{onChange:(e:{target:{value:string}})=>void}>|undefined{if(Array.isArray(node))return node.map(x=>select(x,label)).find(Boolean);if(!isValidElement<{children?:ReactNode;'aria-label'?:string}>(node))return;if(node.type==='select'&&node.props['aria-label']===label)return node as ReactElement<{onChange:(e:{target:{value:string}})=>void}>;return select(node.props.children,label);}
describe('independently timed whole-sentence exit',()=>{
 it('calibrates against the actual historical fragment-producing sequence and preserves entrance',async()=>{
  const good=await prepared(),bad=await prepared(false);
  for(let f=0;f<46;f++)expect(motionGraphicV2FrameReceipt(good.project,good.graphic,f,good.layout).segments).toEqual(motionGraphicV2FrameReceipt(bad.project,bad.graphic,f,bad.layout).segments);
  const complete=(segments:ReturnType<typeof motionGraphicV2FrameReceipt>['segments'])=>new Set(segments.map(x=>x.opacity)).size===1;
  expect(complete(motionGraphicV2FrameReceipt(bad.project,bad.graphic,56,bad.layout).segments)).toBe(false);
  for(let f=52;f<60;f++){const receipt=motionGraphicV2FrameReceipt(good.project,good.graphic,f,good.layout);expect(complete(receipt.segments)).toBe(true);expect(new Set(receipt.segments.map(x=>x.translateYPixels)).size).toBe(1);}
  expect(motionGraphicV2FrameReceipt(good.project,good.graphic,59,good.layout).segments.every(x=>x.opacity===0)).toBe(true);
  const evidence=process.env.EDITKIN_WHOLE_EXIT_EVIDENCE;if(evidence)await writeFile(join(evidence,'CALIBRATED_PHYSICAL_FRAMES.json'),JSON.stringify({knownGood:motionGraphicV2FrameReceipt(good.project,good.graphic,56,good.layout),knownBad:motionGraphicV2FrameReceipt(bad.project,bad.graphic,56,bad.layout),physicalFont:good.layout.physicalFont},null,2));
 });
 it('writes actual physical glyph ASS with identical exit opacity for every sentence glyph',async()=>{
  const f=await prepared();const ass=writeAssContent(f.project,f.project.captionStyle,{requirePhysicalGlyphs:true,physicalLayouts:new Map([[f.graphic.id,f.layout]])});
  const lines=ass.split('\n').filter(x=>x.startsWith('Dialogue: 2,0:00:01.86,0:00:01.90,'));expect(lines).toHaveLength(4);
  for(const segment of f.layout.segments)expect(lines.some(x=>x.includes(`}${segment.outline!.ass}{\\p0}`))).toBe(true);
  const alphas=lines.map(x=>x.match(/\\1a(&H[0-9A-F]{2}&)/i)?.[1]);expect(alphas.every(Boolean)).toBe(true);expect(new Set(alphas).size).toBe(1);
 });
 it('retains exact optional timing through saved project and source/preset identity',async()=>{
  const good=await prepared(),bad=await prepared(false),saved=projectSchema.parse(JSON.parse(canonicalJson(good.project))),legacy=projectSchema.parse(JSON.parse(canonicalJson(bad.project)));
  expect(saved.motionGraphics[0].motionV2!.sequence.exitStaggerFrames).toBe(0);expect(legacy.motionGraphics[0].motionV2!.sequence).not.toHaveProperty('exitStaggerFrames');
  expect(good.packet.authoringSha256).not.toBe(bad.packet.authoringSha256);expect(good.packet.graphicBindings[0].presetVariant.overrides.motionV2!.sequence.exitStaggerFrames).toBe(0);
  expect(motionGraphicV2FrameReceipt(saved,saved.motionGraphics[0],56,good.layout)).toEqual(motionGraphicV2FrameReceipt(good.project,good.graphic,56,good.layout));
 });
 it('uses the real reading floor for independent timing and rejects insufficient hold',async()=>{
  const minimum=await prepared(true,46);expect(()=>assertScopedMotionReadingHold(minimum.graphic,30)).not.toThrow();
  await expect(prepared(true,45)).rejects.toThrow(/閱讀停留/);await expect(prepared(false,46)).rejects.toThrow(/閱讀停留/);
 });
 it('refuses invalid independent timing at both strict source and production contracts',async()=>{
  const valid=await prepared();for(const value of [-1,121,.5,NaN,Infinity,'0',null]){const raw=structuredClone(valid.input);Object.assign(raw.elements[0].motionV2!.sequence,{exitStaggerFrames:value});expect(originalMotionScene2dInputSchema.safeParse(raw).success).toBe(false);const graphic=structuredClone(valid.graphic);Object.assign(graphic.motionV2!.sequence,{exitStaggerFrames:value});expect(()=>assertMotionGraphicV2Contract(graphic,30)).toThrow();}
 });
 it('ordinary author control commits together and restores omitted legacy cadence',async()=>{
  const f=await prepared(false);let g=f.graphic;const update=(patch:Partial<typeof g>)=>{g={...g,...patch};};
  select(MotionTextLayoutControls({graphic:g,onUpdate:update}),`${g.name}退場方式`)!.props.onChange({target:{value:'together'}});expect(g.motionV2!.sequence.exitStaggerFrames).toBe(0);
  select(MotionTextLayoutControls({graphic:g,onUpdate:update}),`${g.name}退場方式`)!.props.onChange({target:{value:'staggered'}});expect(g.motionV2!.sequence).not.toHaveProperty('exitStaggerFrames');
 });
 it('saved original owner revision physically prepares and reopens the new cadence with camera retained',async()=>{
  const f=await prepared(false),motion=structuredClone(f.graphic.motionV2!);motion.sequence.exitStaggerFrames=0;
  const revision=await prepareOriginalSceneGraphicRevision(f.project,{expectedRevision:f.project.revision,sceneId:'whole-exit',edits:[{graphicId:f.graphic.id,motionV2:motion}]},deps);
  const edited=applyCommand(f.project,revision.commands[0]),reopened=projectSchema.parse(JSON.parse(canonicalJson(edited)));
  expect(reopened.motionScenes).toEqual(f.project.motionScenes);expect(reopened.motionGraphics[0].motionV2!.sequence.exitStaggerFrames).toBe(0);
  const markup=renderToStaticMarkup(<SavedOriginalMotionScenes project={reopened} sessionId={1} busy={false} onCancel={()=>{}} onRevise={()=>{}}/>);expect(markup).toContain('退場間隔影格（0 = 整句）');
 });
 it('publishes exact source-only capability without certifying installed/native output',()=>{
  expect(compactAutopilotContract().originalSourceExecution.explicitElementAnimationV2).toMatchObject({independentExitStaggerFrames:true,wholeSentenceExit:'sequence.exitStaggerFrames=0',omittedExitStaggerFrames:'preserve_entrance_stagger',sourceAdmissionOnly:true,installedOrFullProductCertified:false});
 });
});
