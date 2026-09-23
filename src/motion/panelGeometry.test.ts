import {describe,it,expect} from 'vitest';
import {motionPanelPaths} from './panelGeometry';
describe('shared motion panel contours',()=>{
 it('uses the same fractional inside border instead of CSS integer snapping',()=>{
  const p=motionPanelPaths(820.8,128.4,24,3.5);expect(p.borderAss).toContain('3.5');
  expect(p.fillSvg.replace(/ Z/g,'').replace(/C/g,'b').replace(/M/g,'m').replace(/L/g,'l')).toBe(p.fillAss);
  expect(p.borderSvg.replace(/ Z/g,'').replace(/C/g,'b').replace(/M/g,'m').replace(/L/g,'l')).toBe(p.borderAss);
 });
 it('handles zero or oversized outlines without negative inner boxes',()=>{
  expect(motionPanelPaths(10,10,20,0).borderSvg).toBe('');expect(motionPanelPaths(10,10,20,100).borderAss).not.toContain('-');
  expect(motionPanelPaths(10,10,20,100).borderAss).toBe(motionPanelPaths(10,10,20,0).fillAss);
 });
 it('rejects invalid geometry',()=>{for(const width of [0,-1,NaN,Infinity])expect(()=>motionPanelPaths(width,10,2,1)).toThrow();});
});
