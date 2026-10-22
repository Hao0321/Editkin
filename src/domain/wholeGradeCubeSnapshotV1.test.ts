import {describe,it,expect} from 'vitest';
import {createDemoProject} from './demo';
import {captureWholeGradeCubeV1} from './wholeGradeCubeSnapshotV1';
describe('Read-only current-frame whole-grade recipe',()=>{
  it('captures animated Primary and a separately identified legacy look without creating state changes',()=>{
    const p=createDemoProject(),c=p.tracks[0].clips[0];c.duration=4;c.timelineStart=2;c.color.exposure=0;
    c.gradeV2={schema:'editkin.color-grade/v2',nodes:[{id:'n',gain:{r:.1}}]};
    c.keyframes=[{id:'a',time:0,transform:{...c.transform},color:{...c.color,exposure:0},easing:'linear'},{id:'b',time:4,transform:{...c.transform},color:{...c.color,exposure:2},easing:'linear'}];
    p.tracks[0].locked=true;const before=JSON.stringify(p),s=captureWholeGradeCubeV1(p,c.id,4);
    expect(s.color.exposure).toBe(1);expect(s.localTime).toBe(2);expect(s.gradeV2).toEqual(c.gradeV2);expect(s.excluded.animationBeyondSample).toBe(true);expect(JSON.stringify(p)).toBe(before);
    s.color.exposure=-1;s.gradeV2!.nodes![0].gain!.r=.9;expect(JSON.stringify(p)).toBe(before);
  });
  it('refuses unresolved source contexts and invalid clocks while preserving the full project',()=>{
    const p=createDemoProject(),c=p.tracks[0].clips[0],before=JSON.stringify(p);
    expect(()=>captureWholeGradeCubeV1(p,c.id,NaN)).toThrow();expect(()=>captureWholeGradeCubeV1(p,'missing',0)).toThrow();expect(JSON.stringify(p)).toBe(before);
    p.assets[0].kind='audio';expect(()=>captureWholeGradeCubeV1(p,c.id,0)).toThrow(/轉換器/);
  });
});
