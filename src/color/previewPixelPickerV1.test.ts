import {it,expect} from 'vitest';
import {previewPickerPointV1,previewPickerPatchV1,previewPickerValuesV1,previewPickerOwnerKeyV1,previewFramePipelineKeyV1,samePreviewFrameV1} from './previewPixelPickerV1';
it('maps actual contain content at borders and rejects letterbox instead of clamping it',()=>{
  const size={width:320,height:180},rect={left:100,top:50,width:642,height:402},border={left:1,right:1,top:1,bottom:1};
  expect(previewPickerPointV1(size,rect,{x:421,y:251},border)).toEqual({x:160,y:90});expect(previewPickerPointV1(size,rect,{x:101,y:71},border)).toEqual({x:0,y:0});
  expect(previewPickerPointV1(size,rect,{x:421,y:60},border)).toBeUndefined();expect(previewPickerPointV1(size,rect,{x:741,y:251},border)).toBeUndefined();
  expect(previewPickerPointV1({width:180,height:320},{left:0,top:0,width:400,height:640},{x:100,y:100})).toEqual({x:40,y:50});
  expect(()=>previewPickerPointV1(size,rect,{x:NaN,y:0})).toThrow();
});
it('caps clipped edge patches at nine pixels per axis',()=>{
  expect(previewPickerPatchV1(320,180,0,0,9)).toEqual({x:0,y:0,width:5,height:5});expect(previewPickerPatchV1(320,180,319,179,9)).toEqual({x:315,y:175,width:5,height:5});
  expect(previewPickerPatchV1(2,2,1,1,9)).toEqual({x:0,y:0,width:2,height:2});expect(()=>previewPickerPatchV1(10,10,10,0,1)).toThrow();expect(()=>previewPickerPatchV1(10,10,0,0,11)).toThrow();
});
it('reads alpha-weighted RGB/hex/HSL; achromatic hue is undefined',()=>{
  const red=previewPickerValuesV1(new Uint8ClampedArray([255,0,0,255]));expect(red).toMatchObject({rgb:[255,0,0],hex:'#FF0000',hueDegrees:0,saturation:1,lightness:.5});
  expect(previewPickerValuesV1(new Uint8ClampedArray([0,255,0,255])).hueDegrees).toBe(120);expect(previewPickerValuesV1(new Uint8ClampedArray([0,0,255,255])).hueDegrees).toBe(240);
  expect(previewPickerValuesV1(new Uint8ClampedArray([128,128,128,255]))).toMatchObject({hueDegrees:null,saturation:0});
  expect(previewPickerValuesV1(new Uint8ClampedArray([255,0,0,255,0,0,255,0,0,255,0,128])).rgb).toEqual([170,85,0]);
  expect(()=>previewPickerValuesV1(new Uint8ClampedArray([1,2,3,0]))).toThrow('不透明');expect(()=>previewPickerValuesV1(new Uint8ClampedArray(328))).toThrow();
});
it('uses private owner identity without serializing a large/cyclic session',()=>{
  const owner:any={};owner.self=owner;const scope={owner,sessionId:1},a=previewPickerOwnerKeyV1('clip',scope);expect(previewPickerOwnerKeyV1('clip',scope)).toBe(a);expect(previewPickerOwnerKeyV1('other',scope)).not.toBe(a);expect(previewPickerOwnerKeyV1('clip',{owner:{},sessionId:1})).not.toBe(a);expect(previewPickerOwnerKeyV1('clip',{owner,sessionId:2})).not.toBe(a);
});
it('binds actual producer recipe, primary and video time',()=>{
  const pipelineKey=previewFramePipelineKeyV1({asset:{id:'a'},source:'own',management:{mode:'rec709'},ownerKey:'one'}),a={pipelineKey,primaryKey:'rgb',sourceTime:1.4};expect(samePreviewFrameV1(a,{...a,sourceTime:1.40001})).toBe(true);for(const b of [{...a,primaryKey:'other'},{...a,pipelineKey:'other'},{...a,sourceTime:0},{...a,sourceTime:NaN}])expect(samePreviewFrameV1(a,b)).toBe(false);
});
