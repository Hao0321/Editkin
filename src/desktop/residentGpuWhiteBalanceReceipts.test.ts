import {describe,it,expect} from 'vitest';
import {adjustmentReceiptMatches,engineVisualMatches} from './residentGpuPreviewValidation';
import {DEFAULT_COLOR} from '../domain/types';
type Receipt=Parameters<typeof adjustmentReceiptMatches>[0];
type Expected=Parameters<typeof adjustmentReceiptMatches>[1];
type Graph=Parameters<typeof adjustmentReceiptMatches>[2];
function fixture(processor='editkin-rec709-primary/v2',stops=[.5,-.25,0]){
  const grade={...DEFAULT_COLOR,whiteBalanceRed:stops[0],whiteBalanceGreen:stops[1],whiteBalanceBlue:stops[2]};
  const timeline={timelineStartFrame:0,sourceStartFrame:0,durationFrames:30};
  const visual={...grade,effectKind:0,shaderOpCount:0,sourceWidth:960,sourceHeight:540,translateX:0,translateY:0,scale:1,rotation:0,opacity:1,blendMode:0,matteMode:0,compositeOpacity:1,motionSampleCount:0,motionContractCode:0,motionShutterAngle:0};
  const expected={nodeIds:['adjustment'],effectKind:0,shaderEffectExpected:false,adjustment:{timeline},grade:{processor,grade}} as unknown as Expected;
  const receipt={nodeIds:['adjustment'],timeline,visualGraph:visual} as unknown as Receipt;
  if (processor.endsWith('/v2')) receipt.visualGraph.inputTransfer=processor==='editkin-rec709-to-linear-rec709-primary/v2'?2:processor==='editkin-linear-primary/v2'?0:1;
  return {expected,receipt,graph:{width:960,height:540} as Graph};
}
describe('actual native adjustment receipt white-balance binding',()=>{
  it('requires every explicit zero channel for zero-gain v2 as well',()=>{for(const key of ['whiteBalanceRed','whiteBalanceGreen','whiteBalanceBlue'] as const){const f=fixture('editkin-rec709-primary/v2',[0,0,0]);expect(adjustmentReceiptMatches(f.receipt,f.expected,f.graph)).toBe(true);delete f.receipt.visualGraph[key];expect(adjustmentReceiptMatches(f.receipt,f.expected,f.graph)).toBe(false);}});
  it('rejects missing or mismatched physical input transfer on v2',()=>{const f=fixture('editkin-rec709-to-linear-rec709-primary/v2');delete f.receipt.visualGraph.inputTransfer;expect(adjustmentReceiptMatches(f.receipt,f.expected,f.graph)).toBe(false);f.receipt.visualGraph.inputTransfer=1;expect(adjustmentReceiptMatches(f.receipt,f.expected,f.graph)).toBe(false);f.receipt.visualGraph.inputTransfer=2;expect(adjustmentReceiptMatches(f.receipt,f.expected,f.graph)).toBe(true);});
  it.each(['editkin-rec709-primary/v2','editkin-rec709-to-linear-rec709-primary/v2','editkin-linear-primary/v2'])('accepts matching %s complete stops',processor=>{const f=fixture(processor);expect(adjustmentReceiptMatches(f.receipt,f.expected,f.graph)).toBe(true);});
  it.each(['whiteBalanceRed','whiteBalanceGreen','whiteBalanceBlue'] as const)('rejects missing and changed %s for v2',key=>{const f=fixture();delete f.receipt.visualGraph[key];expect(adjustmentReceiptMatches(f.receipt,f.expected,f.graph)).toBe(false);f.receipt.visualGraph[key]=1;expect(adjustmentReceiptMatches(f.receipt,f.expected,f.graph)).toBe(false);});
  it.each([NaN,Infinity,-Infinity,4.001,-4.001,null,'0'])('rejects invalid actual channel %s',value=>{const f=fixture();Object.assign(f.receipt.visualGraph,{whiteBalanceRed:value});expect(adjustmentReceiptMatches(f.receipt,f.expected,f.graph)).toBe(false);});
  it('rejects unsupported processors and v1 nonzero even with matching receipt values',()=>{for(const processor of ['editkin-rec709-primary/v1','unrecognized/v2']){const f=fixture(processor);expect(adjustmentReceiptMatches(f.receipt,f.expected,f.graph)).toBe(false);}});
  it('allows omitted channels only for zero expected v1',()=>{const f=fixture('editkin-rec709-primary/v1',[0,0,0]);delete f.receipt.visualGraph.whiteBalanceRed;delete f.receipt.visualGraph.whiteBalanceGreen;delete f.receipt.visualGraph.whiteBalanceBlue;expect(adjustmentReceiptMatches(f.receipt,f.expected,f.graph)).toBe(true);f.expected.grade.processor='editkin-rec709-primary/v2';expect(adjustmentReceiptMatches(f.receipt,f.expected,f.graph)).toBe(false);});
  it('accepts finite exact endpoints and f32 transport, not meaningful drift',()=>{const f=fixture('editkin-rec709-primary/v2',[-4,4,.3]);f.receipt.visualGraph.whiteBalanceBlue=Math.fround(.3);expect(adjustmentReceiptMatches(f.receipt,f.expected,f.graph)).toBe(true);f.receipt.visualGraph.whiteBalanceBlue=.31;expect(adjustmentReceiptMatches(f.receipt,f.expected,f.graph)).toBe(false);});
  it('rejects malformed expected channel too',()=>{const f=fixture();(f.expected.grade.grade as Record<string,unknown>).whiteBalanceRed=NaN;expect(adjustmentReceiptMatches(f.receipt,f.expected,f.graph)).toBe(false);});
  it('binds actual video layer receipt as well as adjustment layer',()=>{
    const f=fixture();const expected={...f.expected,transform:{kind:'transform2d',x:0,y:0,scaleX:1,rotationRadians:0,opacity:1},blendMode:'normal',compositeOpacity:1} as unknown as Parameters<typeof engineVisualMatches>[1];
    Object.assign(f.receipt.visualGraph,{projectiveEnabled:0,motionSampleFrames:[[0,0,0,0],[0,0,0,0]]});
    expect(engineVisualMatches(f.receipt.visualGraph,expected,[expected],[],f.graph,0)).toBe(true);
    f.receipt.visualGraph.whiteBalanceGreen=0;expect(engineVisualMatches(f.receipt.visualGraph,expected,[expected],[],f.graph,0)).toBe(false);
  });
});
