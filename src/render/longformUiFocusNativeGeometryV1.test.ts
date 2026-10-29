import { describe,expect,it } from "vitest";
import { longformUiFocusNativeOutlineV1 as outline,longformUiFocusNativeSvgV1 } from "./longformUiFocusNativeGeometryV1";
const quad=[{x:.2,y:.2},{x:.6,y:.2},{x:.6,y:.4},{x:.2,y:.4}];
describe('source-display native focus outline geometry',()=>{
  it('uses the shared rounded contour and an inside hole without a centered stroke',()=>{
    const path=outline(1280,720,quad,4,8,720*200/1080);
    expect(path.fill_rule).toBe('even_odd');expect(path.commands.filter(c=>c.type==='M')).toHaveLength(2);expect(path.commands.filter(c=>c.type==='Z')).toHaveLength(2);
    expect(path.commands[0]).toEqual({type:'M',x:264,y:144});expect(path.commands[10]).toEqual({type:'M',x:264,y:148});
    expect(path.commands.filter(c=>c.type==='C')).toHaveLength(8);expect(longformUiFocusNativeSvgV1(path)).toContain('Z M');
  });
  it('translates every path point exactly with a moved target',()=>{
    const a=outline(1280,720,quad,4,8,100),b=outline(1280,720,quad.map(p=>({x:p.x+.1,y:p.y+.1})),4,8,100);
    a.commands.forEach((row,i)=>{const next=b.commands[i];expect(next.type).toBe(row.type);if(row.type!=='Z'&&next.type!=='Z'){
      expect(next.x-row.x).toBeCloseTo(128,7);expect(next.y-row.y).toBeCloseTo(72,7);}});
  });
  it('retains affine rotation as exact curves and adaptively projects perspective corners',()=>{
    const affine=[{x:.3,y:.2},{x:.6,y:.3},{x:.55,y:.45},{x:.25,y:.35}],perspective=[{x:.2,y:.2},{x:.7,y:.25},{x:.55,y:.5},{x:.3,y:.4}];
    expect(outline(1280,720,affine,4,8,100).commands.filter(c=>c.type==='C')).toHaveLength(8);
    const projected=outline(1280,720,perspective,4,8,100);expect(projected.commands.some(c=>c.type==='C')).toBe(false);expect(projected.commands.length).toBeGreaterThan(22);
    expect(projected.commands.every(c=>c.type==='Z'||(Number.isFinite(c.x)&&Number.isFinite(c.y)&&c.x>=256&&c.x<=896&&c.y>=144&&c.y<=360))).toBe(true);
  });
  it('refuses folded, clipped, subtitle-overlapping and tiny targets without clamping',()=>{
    for(const q of [[quad[0],quad[2],quad[1],quad[3]],quad.map(p=>({...p,x:p.x-.3})),quad.map(p=>({...p,y:p.y+.5})),
      quad.map(p=>({x:.2+(p.x-.2)*.01,y:p.y}))])expect(()=>outline(1280,720,q,4,8,720*200/1080)).toThrow(/UI_FOCUS_NATIVE_GEOMETRY/);
    expect(()=>outline(1281,720,quad,4,8,100)).toThrow('BOUNDS');
  });
});
