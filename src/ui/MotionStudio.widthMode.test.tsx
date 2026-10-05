import {isValidElement,type ReactNode,type ReactElement} from 'react';
import {describe,it,expect,vi} from 'vitest';
import MotionStudio from './MotionStudio';
import {createDemoProject} from '../domain/demo';
import {applyCommand} from '../domain/commands';
import {projectSchema} from '../domain/schema';
import {createMotionGraphic} from '../motion/composition';
import {findMotionGraphicPreset} from '../creative/motionGraphicPresets';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {bundledFontFaceSpec} from '../typography/bundledFontCatalog';
import {prepareGlyphRun} from '../typography/preparedGlyphRun';
import {motionGraphicV2PhysicalLayoutReceipt} from '../motion/compositionV2';
import {DEFAULT_CLIP_LAYER} from '../domain/types';
function findSelect(node:ReactNode,label?:string):ReactElement<{onChange:(event:{target:{value:string}})=>void}>|undefined {
 if(Array.isArray(node))return node.map(item=>findSelect(item,label)).find(Boolean);
 if(!isValidElement<{children?:ReactNode}>(node))return;
 if(node.type==='select'&&(!label||(node.props as Record<string,unknown>)['aria-label']===label))return node as ReactElement<{onChange:(event:{target:{value:string}})=>void}>;
 return findSelect(node.props.children,label);
}
describe('MotionStudio content-width control',()=>{
 it('lets the actual native vector selector persist foreground/background without changing its geometry',()=>{
  const p=createDemoProject(),g=createMotionGraphic('stage','card','',0,3,undefined,findMotionGraphicPreset('reel_native_panel').seed);p.motionGraphics=[g];
  const update=vi.fn(),noop=()=>{},tree=MotionStudio({asset:p.assets[0],motionTracks:[],motionGraphics:[g],wave2Presets:[],trackingBusy:false,trackingSelectionActive:false,onBeginMotionTrack:noop,onCorrectMotionTrack:noop,onDeleteMotionTrack:noop,onAddMotionGraphic:noop,onUpdateMotionGraphic:update,onDeleteMotionGraphic:noop});
  const select=findSelect(tree);expect(select).toBeDefined();select!.props.onChange({target:{value:'background'}});
  const patch={compositeLayer:'background',vectorV2:{...g.vectorV2,schema:'editkin.motion-vector-stage/v1'}};
  expect(update).toHaveBeenCalledWith(g.id,patch);
  const changed=applyCommand(p,{type:'update_motion_graphic',graphicId:g.id,patch:update.mock.calls[0][1]});
  const reopened=projectSchema.parse(JSON.parse(JSON.stringify(changed)));expect(reopened.motionGraphics[0]).toEqual({...g,...patch});expect(g.compositeLayer).toBeUndefined();
 });
 it('calls the actual selector handler and roundtrips its structured update',()=>{
  const p=createDemoProject(),g=createMotionGraphic('width','title','保留完整標題',0,3,undefined,findMotionGraphicPreset('v2-word-cascade').seed);p.motionGraphics=[g];
  const update=vi.fn(),noop=()=>{},tree=MotionStudio({asset:p.assets[0],motionTracks:[],motionGraphics:[g],wave2Presets:[],trackingBusy:false,trackingSelectionActive:false,onBeginMotionTrack:noop,onCorrectMotionTrack:noop,onDeleteMotionTrack:noop,onAddMotionGraphic:noop,onUpdateMotionGraphic:update,onDeleteMotionGraphic:noop});
  const select=findSelect(tree,`${g.name}底框寬度`);expect(select).toBeDefined();select!.props.onChange({target:{value:'fit_content'}});
  expect(update).toHaveBeenCalledWith(g.id,{layoutV2:{...g.layoutV2,widthMode:'fit_content'}});
  const changed=applyCommand(p,{type:'update_motion_graphic',graphicId:g.id,patch:update.mock.calls[0][1]});
  const reopened=projectSchema.parse(JSON.parse(JSON.stringify(changed)));expect(reopened.motionGraphics[0].text).toBe(g.text);expect(reopened.motionGraphics[0].layoutV2?.widthMode).toBe('fit_content');expect(g.layoutV2?.widthMode).toBeUndefined();
  const restored=applyCommand(reopened,{type:'update_motion_graphic',graphicId:g.id,patch:{layoutV2:g.layoutV2}});expect(restored.motionGraphics[0]).toEqual(g);
 });
 it('selects a bundled physical font on the same graphic, preserves unrelated content and rebuilds authentic contours after storage',async()=>{
  const p=projectSchema.parse(createDemoProject()),g=createMotionGraphic('font','title','AV 12',0,3,undefined,findMotionGraphicPreset('v2-word-cascade').seed);
  // The command path normalizes missing default layer/expressions on every edit.
  // Start from the same hydrated clip state as the current authoring session.
  for(const track of p.tracks)for(const clip of track.clips){clip.layer={...DEFAULT_CLIP_LAYER,...clip.layer};clip.expressions??={};}
  p.motionGraphics=[g,createMotionGraphic('unchanged','card','其他圖文',1,3)];
  const update=vi.fn(),noop=()=>{},tree=MotionStudio({asset:p.assets[0],motionTracks:[],motionGraphics:p.motionGraphics,wave2Presets:[],trackingBusy:false,trackingSelectionActive:false,onBeginMotionTrack:noop,onCorrectMotionTrack:noop,onDeleteMotionTrack:noop,onAddMotionGraphic:noop,onUpdateMotionGraphic:update,onDeleteMotionGraphic:noop});
  const select=findSelect(tree,`${g.name}字型`);expect(select).toBeDefined();
  select!.props.onChange({target:{value:'Bebas Neue'}});
  expect(update).toHaveBeenCalledExactlyOnceWith(g.id,{fontFamily:'Bebas Neue',fontWeight:400});
  const changed=applyCommand(p,{type:'update_motion_graphic',graphicId:g.id,patch:update.mock.calls[0][1]});
  const reopened=projectSchema.parse(JSON.parse(JSON.stringify(changed))),edited=reopened.motionGraphics[0];
  expect(edited).toEqual({...g,fontFamily:'Bebas Neue',fontWeight:400});
  expect(reopened.motionGraphics[1]).toEqual(p.motionGraphics[1]);
  for(const field of ['assets','tracks','captions','motionTracks','motionScenes','width','height','fps'] as const)expect(reopened[field]).toEqual(p[field]);
  const spec=bundledFontFaceSpec('EditkinFace-bebas-neue-400');
  const run=await prepareGlyphRun(spec.faceId,edited.text,new Uint8Array(await readFile(resolve('public/fonts',spec.fontFile))));
  const layout=motionGraphicV2PhysicalLayoutReceipt(reopened,edited,run);
  expect(layout.physicalFont).toMatchObject({faceId:spec.faceId,fontSha256:spec.sha256});
  expect(layout.segments.every(segment=>Boolean(segment.outline?.svg&&segment.outline.ass))).toBe(true);
  expect(()=>motionGraphicV2PhysicalLayoutReceipt(p,g,run)).toThrow(/字型.*不一致/);
  select!.props.onChange({target:{value:'unbundled-path'}});expect(update).toHaveBeenCalledTimes(1);
  const managed=MotionStudio({asset:p.assets[0],motionTracks:[],motionGraphics:[g],managedMotionGraphicIds:[g.id],wave2Presets:[],trackingBusy:false,trackingSelectionActive:false,onBeginMotionTrack:noop,onCorrectMotionTrack:noop,onDeleteMotionTrack:noop,onAddMotionGraphic:noop,onUpdateMotionGraphic:update,onDeleteMotionGraphic:noop});
  expect(findSelect(managed,`${g.name}字型`)).toBeUndefined();
 });
});
