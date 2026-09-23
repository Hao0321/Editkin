import {isValidElement,type ReactNode,type ReactElement} from 'react';
import {describe,it,expect,vi} from 'vitest';
import MotionStudio from './MotionStudio';
import {createDemoProject} from '../domain/demo';
import {applyCommand} from '../domain/commands';
import {projectSchema} from '../domain/schema';
import {createMotionGraphic} from '../motion/composition';
import {findMotionGraphicPreset} from '../creative/motionGraphicPresets';
function findSelect(node:ReactNode):ReactElement<{onChange:(event:{target:{value:string}})=>void}>|undefined {
 if(Array.isArray(node))return node.map(findSelect).find(Boolean);
 if(!isValidElement<{children?:ReactNode}>(node))return;
 if(node.type==='select')return node as ReactElement<{onChange:(event:{target:{value:string}})=>void}>;
 return findSelect(node.props.children);
}
describe('MotionStudio content-width control',()=>{
 it('calls the actual selector handler and roundtrips its structured update',()=>{
  const p=createDemoProject(),g=createMotionGraphic('width','title','保留完整標題',0,3,undefined,findMotionGraphicPreset('v2-word-cascade').seed);p.motionGraphics=[g];
  const update=vi.fn(),noop=()=>{},tree=MotionStudio({asset:p.assets[0],motionTracks:[],motionGraphics:[g],wave2Presets:[],trackingBusy:false,trackingSelectionActive:false,onBeginMotionTrack:noop,onCorrectMotionTrack:noop,onDeleteMotionTrack:noop,onAddMotionGraphic:noop,onUpdateMotionGraphic:update,onDeleteMotionGraphic:noop});
  const select=findSelect(tree);expect(select).toBeDefined();select!.props.onChange({target:{value:'fit_content'}});
  expect(update).toHaveBeenCalledWith(g.id,{layoutV2:{...g.layoutV2,widthMode:'fit_content'}});
  const changed=applyCommand(p,{type:'update_motion_graphic',graphicId:g.id,patch:update.mock.calls[0][1]});
  const reopened=projectSchema.parse(JSON.parse(JSON.stringify(changed)));expect(reopened.motionGraphics[0].text).toBe(g.text);expect(reopened.motionGraphics[0].layoutV2?.widthMode).toBe('fit_content');expect(g.layoutV2?.widthMode).toBeUndefined();
  const restored=applyCommand(reopened,{type:'update_motion_graphic',graphicId:g.id,patch:{layoutV2:g.layoutV2}});expect(restored.motionGraphics[0]).toEqual(g);
 });
});
