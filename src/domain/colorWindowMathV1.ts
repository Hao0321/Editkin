import { colorWindowRefuseV1, type ColorWindowPointV1 as Point } from "./colorWindowV1";

/** Row-major projective map; the closed form maps the unit square to a convex quad. */
export type ColorWindowMatrixV1 = readonly [number,number,number,number,number,number,number,number,number];
export function colorWindowQuadMatrixV1(points: readonly Point[]): ColorWindowMatrixV1 {
  if (points.length!==4) colorWindowRefuseV1("COLOR_WINDOW_PATH");
  const [a,b,c,d]=points, dx=b.x-c.x, ex=d.x-c.x, sx=a.x-b.x+c.x-d.x;
  const dy=b.y-c.y, ey=d.y-c.y, sy=a.y-b.y+c.y-d.y;
  let g=0,h=0;
  if (Math.abs(sx)+Math.abs(sy)>1e-14) {
    const denominator=dx*ey-ex*dy;
    if (Math.abs(denominator)<1e-14) colorWindowRefuseV1("COLOR_WINDOW_PATH");
    g=(sx*ey-ex*sy)/denominator; h=(dx*sy-sx*dy)/denominator;
  }
  const result: ColorWindowMatrixV1=[b.x-a.x+g*b.x,d.x-a.x+h*d.x,a.x,b.y-a.y+g*b.y,d.y-a.y+h*d.y,a.y,g,h,1];
  if (result.some(n=>!Number.isFinite(n)) || [1,1+g,1+h,1+g+h].some(n=>n<=1e-12)) colorWindowRefuseV1("COLOR_WINDOW_PATH");
  return result;
}
export function colorWindowMapPointV1(m: ColorWindowMatrixV1, p: Point): Point {
  const w=m[6]*p.x+m[7]*p.y+m[8];
  if (!Number.isFinite(w) || Math.abs(w)<1e-12) colorWindowRefuseV1("COLOR_WINDOW_PATH");
  const point={x:(m[0]*p.x+m[1]*p.y+m[2])/w,y:(m[3]*p.x+m[4]*p.y+m[5])/w};
  if (![point.x,point.y].every(Number.isFinite)) colorWindowRefuseV1("COLOR_WINDOW_PATH");
  return point;
}
export function colorWindowInverseMatrixV1(m: ColorWindowMatrixV1): ColorWindowMatrixV1 {
  const [a,b,c,d,e,f,g,h,i]=m;
  const out=[e*i-f*h,c*h-b*i,b*f-c*e,f*g-d*i,a*i-c*g,c*d-a*f,d*h-e*g,b*g-a*h,a*e-b*d];
  const determinant=a*out[0]+b*out[3]+c*out[6];
  if (!Number.isFinite(determinant) || Math.abs(determinant)<1e-14) colorWindowRefuseV1("COLOR_WINDOW_PATH");
  return out.map(n=>n/determinant) as unknown as ColorWindowMatrixV1;
}
export function colorWindowPolygonDistanceV1(points: readonly Point[], x: number, y: number): number {
  let inside=false, distance=Infinity;
  for(let i=0;i<points.length;i++) {
    const a=points[i], b=points[(i+1)%points.length], dx=b.x-a.x,dy=b.y-a.y;
    const t=Math.max(0,Math.min(1,((x-a.x)*dx+(y-a.y)*dy)/(dx*dx+dy*dy)));
    distance=Math.min(distance,Math.hypot(x-a.x-t*dx,y-a.y-t*dy));
    if ((a.y>y)!==(b.y>y) && x<(b.x-a.x)*(y-a.y)/(b.y-a.y)+a.x) inside=!inside;
  }
  return inside ? distance : -distance;
}

/** Analytic ellipse level-set distance scaled by its screen-space gradient (exact for circles).
 * It keeps feather units in plane pixels under a perspective quad, rather than normalized RGB/UV units. */
export function colorWindowEllipseDistanceV1(inverse: ColorWindowMatrixV1, x: number, y: number, centerDepth: number): number {
  const w=inverse[6]*x+inverse[7]*y+inverse[8];
  if (Math.abs(w)<1e-12 || !Number.isFinite(w)) return -Infinity;
  const s=(inverse[0]*x+inverse[1]*y+inverse[2])/w, t=(inverse[3]*x+inverse[4]*y+inverse[5])/w;
  const u=2*s-1,v=2*t-1,r=Math.hypot(u,v);
  if (r<1e-12) return centerDepth;
  const gx=(u*2*(inverse[0]-s*inverse[6])+v*2*(inverse[3]-t*inverse[6]))/(w*r);
  const gy=(u*2*(inverse[1]-s*inverse[7])+v*2*(inverse[4]-t*inverse[7]))/(w*r);
  const gradient=Math.hypot(gx,gy);
  return gradient>1e-15 ? (1-r)/gradient : -Infinity;
}
