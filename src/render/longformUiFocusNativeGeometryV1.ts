import { motionPanelContourCommands } from "../motion/panelGeometry";
import { longformUiFocusQuadProjectionV1 } from "../application/longformUiFocusHoldV1";
import type { PreparedGlyphPathCommand } from "../typography/preparedGlyphRun";
import type { NativeVectorPath } from "../motion/nativeGlyphPaint";
type Point = { x: number; y: number };
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const lerp = (a: Point, b: Point, t: number) => ({ x: a.x + (b.x-a.x)*t, y: a.y + (b.y-a.y)*t });
function curve(a: Point, b: Point, c: Point, d: Point, t: number) {
  return lerp(lerp(lerp(a,b,t),lerp(b,c,t),t),lerp(lerp(b,c,t),lerp(c,d,t),t),t);
}
function lineDistance(point: Point, a: Point, b: Point) {
  const dx=b.x-a.x,dy=b.y-a.y,den=dx*dx+dy*dy;
  return distance(point,lerp(a,b,den?Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.y-a.y)*dy)/den)):0));
}
/** Shared rounded contour and inside border. Affine curves stay exact;
 * projective curves are adaptively tessellated in destination pixels. */
export function longformUiFocusNativeOutlineV1(width: number, height: number, quad: readonly Point[],
  outlineWidth: number, cornerRadius: number, bottomReserve: number): NativeVectorPath {
  if (![width,height].every(n=>Number.isSafeInteger(n)&&n>0&&n<=1280) || width*height>1280**2
    || ![outlineWidth,cornerRadius,bottomReserve].every(Number.isFinite) || outlineWidth<=0 || cornerRadius<0 || bottomReserve<0 || bottomReserve>=height
    || quad.length!==4 || quad.some(p=>![p.x,p.y].every(Number.isFinite)||p.x<0||p.y<0||p.x>1||p.y>(height-bottomReserve)/height+1e-10))
    throw Error("UI_FOCUS_NATIVE_GEOMETRY_BOUNDS");
  const pixels=quad.map(p=>({x:p.x*width,y:p.y*height}));
  const cross=pixels.map((a,i)=>{const b=pixels[(i+1)%4],c=pixels[(i+2)%4];return (b.x-a.x)*(c.y-b.y)-(b.y-a.y)*(c.x-b.x)});
  if(!cross.every(n=>n>1e-5)&&!cross.every(n=>n< -1e-5))throw Error("UI_FOCUS_NATIVE_GEOMETRY_FOLDED");
  const w=(distance(pixels[0],pixels[1])+distance(pixels[3],pixels[2]))/2;
  const h=(distance(pixels[0],pixels[3])+distance(pixels[1],pixels[2]))/2;
  if(w<=outlineWidth*2+1||h<=outlineWidth*2+1)throw Error("UI_FOCUS_NATIVE_GEOMETRY_SMALL_TARGET");
  const projection=longformUiFocusQuadProjectionV1(pixels);
  const project=(p:Point)=>{const q=projection(p.x/w,p.y/h);if(![q.x,q.y].every(Number.isFinite))throw Error("UI_FOCUS_NATIVE_GEOMETRY_SINGULAR");return q;};
  const affine=distance({x:pixels[0].x+pixels[2].x,y:pixels[0].y+pixels[2].y},{x:pixels[1].x+pixels[3].x,y:pixels[1].y+pixels[3].y})<1e-7;
  const contours=[motionPanelContourCommands(w,h,cornerRadius),
    motionPanelContourCommands(w-outlineWidth*2,h-outlineWidth*2,Math.max(0,cornerRadius-outlineWidth)).map(command=>{
      if(command.type==='Z')return command;
      const shift=(x:number,y:number)=>({x:x+outlineWidth,y:y+outlineWidth});
      if(command.type==='C')return{type:'C' as const,x1:command.x1+outlineWidth,y1:command.y1+outlineWidth,
        x2:command.x2+outlineWidth,y2:command.y2+outlineWidth,...shift(command.x,command.y)};
      if(command.type==='Q')return{type:'Q' as const,x1:command.x1+outlineWidth,y1:command.y1+outlineWidth,...shift(command.x,command.y)};
      return{type:command.type,...shift(command.x,command.y)};
    })];
  const commands:PreparedGlyphPathCommand[]=[];
  for(const contour of contours){let previous:Point|undefined;
    for(const command of contour){
      if(command.type==='Z'){commands.push(command);previous=undefined;continue;}
      if(command.type==='M'||command.type==='L'){commands.push({type:command.type,...project(command)});previous=command;continue;}
      if(command.type!=='C'||!previous)throw Error("UI_FOCUS_NATIVE_GEOMETRY_CONTOUR");
      const a=previous,b={x:command.x1,y:command.y1},c={x:command.x2,y:command.y2},d={x:command.x,y:command.y};
      if(affine){const pb=project(b),pc=project(c);commands.push({type:'C',x1:pb.x,y1:pb.y,x2:pc.x,y2:pc.y,...project(d)});}
      else{
        const at=(t:number)=>project(curve(a,b,c,d,t));
        const split=(from:number,to:number,depth:number)=>{
          const start=at(from),end=at(to);
          const error=Math.max(...[.25,.5,.75].map(t=>lineDistance(at(from+(to-from)*t),start,end)));
          if(error>.05){if(depth>=12)throw Error("UI_FOCUS_NATIVE_GEOMETRY_TESSELLATION");const middle=(from+to)/2;split(from,middle,depth+1);split(middle,to,depth+1);}
          else commands.push({type:'L',...end});
          if(commands.length>8192)throw Error("UI_FOCUS_NATIVE_GEOMETRY_COMMAND_BUDGET");
        };split(0,1,0);
      }
      previous=d;
    }
  }
  return {commands,fill_rule:'even_odd'};
}
export function longformUiFocusNativeSvgV1(path:NativeVectorPath){return path.commands.map(c=>c.type==='Z'?'Z':c.type==='C'?`C ${c.x1} ${c.y1} ${c.x2} ${c.y2} ${c.x} ${c.y}`:
  c.type==='Q'?`Q ${c.x1} ${c.y1} ${c.x} ${c.y}`:`${c.type} ${c.x} ${c.y}`).join(' ');}
