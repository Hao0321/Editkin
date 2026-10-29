import type { ColorWindowGeometryV1 } from "../domain/colorWindowGeometryV1";
import { colorWindowRefuseV1 } from "../domain/colorWindowV1";

const n=(value:number)=>{if(!Number.isFinite(value))colorWindowRefuseV1("COLOR_WINDOW_PARAMETERS");return String(value);};
const x="(X+0.5)",y="(Y+0.5)";
function polygonProgram(g:ColorWindowGeometryV1):string[] {
  const program=["st(0,1e30)","st(1,0)"];
  for(let i=0;i<g.points.length;i++) {
    const a=g.points[i],b=g.points[(i+1)%g.points.length],dx=b.x-a.x,dy=b.y-a.y;
    const px=`(${x}-${n(a.x)})`,py=`(${y}-${n(a.y)})`;
    program.push(`st(2,clip((${px}*${n(dx)}+${py}*${n(dy)})/${n(dx*dx+dy*dy)},0,1))`,
      `st(0,min(ld(0),pow(${px}-ld(2)*${n(dx)},2)+pow(${py}-ld(2)*${n(dy)},2)))`,
      `st(1,ld(1)+abs(gt(${n(a.y)},${y})-gt(${n(b.y)},${y}))*lt(${x},${n(a.x)}+${py}*${n(dx)}/${n(dy===0?1:dy)}))`);
  }
  program.push(`st(7,if(mod(ld(1),2),sqrt(ld(0)),-sqrt(ld(0)))+${n(g.expansionPx)})`);
  return program;
}
function ellipseProgram(g:ColorWindowGeometryV1):string[] {
  const m=g.ellipseInverse!;
  return [`st(0,${n(m[6])}*${x}+${n(m[7])}*${y}+${n(m[8])})`,
    `st(1,2*(${n(m[0])}*${x}+${n(m[1])}*${y}+${n(m[2])})/ld(0)-1)`,
    `st(2,2*(${n(m[3])}*${x}+${n(m[4])}*${y}+${n(m[5])})/ld(0)-1)`,
    "st(3,sqrt(pow(ld(1),2)+pow(ld(2),2)))",
    `st(4,(ld(1)*2*(${n(m[0])}-(ld(1)+1)*0.5*${n(m[6])})+ld(2)*2*(${n(m[3])}-(ld(2)+1)*0.5*${n(m[6])}))/(ld(0)*ld(3)))`,
    `st(5,(ld(1)*2*(${n(m[1])}-(ld(1)+1)*0.5*${n(m[7])})+ld(2)*2*(${n(m[4])}-(ld(2)+1)*0.5*${n(m[7])}))/(ld(0)*ld(3)))`,
    "st(6,sqrt(pow(ld(4),2)+pow(ld(5),2)))",
    `st(7,if(lt(abs(ld(0)),1e-12),-1e30,if(lt(ld(3),1e-12),${n(g.ellipseCenterDepth!)},if(gt(ld(6),1e-15),(1-ld(3))/ld(6),-1e30)))+${n(g.expansionPx)})`];
}

/** Coverage-plane expression only. Grade segment LUTs and main-composite hooks are separate owners.
 * st/ld registers are overwritten for every pixel; no temporal or slice-thread state is retained.
 */
export function colorWindowGeqExpressionV1(g:ColorWindowGeometryV1,maximum:255|65535=65535):string {
  if (![255,65535].includes(maximum))colorWindowRefuseV1("COLOR_WINDOW_PARAMETERS",g.maskId);
  if (g.status==="lost")return "0";
  let program:string[];
  if (g.kind==="linear_gradient") {
    const [a,b]=g.points,dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy);
    program=[`st(8,clip(0.5+(((${x}-${n(a.x)})*${n(dx)}+(${y}-${n(a.y)})*${n(dy)})/${n(length)}-${n(length/2)}+${n(g.expansionPx)})/${n(length+2*g.featherPx)},0,1))`];
  } else {
    program=g.kind==="ellipse"?ellipseProgram(g):polygonProgram(g);
    program.push(g.featherPx>0?`st(8,clip(0.5+ld(7)/${n(2*g.featherPx)},0,1))`:"st(8,gte(ld(7),0))");
  }
  program.push("st(9,ld(8)*ld(8)*(3-2*ld(8)))",
    `floor(${n(maximum*g.opacity)}*${g.inverted?"(1-ld(9))":"ld(9)"}+0.5)`);
  const result=program.join(";");
  if (result.length>32768)colorWindowRefuseV1("COLOR_WINDOW_RASTER_BUDGET",g.maskId);
  return result;
}
export function colorWindowFfmpegFilterV1(g:ColorWindowGeometryV1,maximum:255|65535=65535):string {
  return `geq=lum='${colorWindowGeqExpressionV1(g,maximum).replaceAll(",","\\,")}'`;
}
