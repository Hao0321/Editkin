import type { ColorWindowGeometryV1 } from "./colorWindowGeometryV1";
import { colorWindowEllipseDistanceV1, colorWindowPolygonDistanceV1 } from "./colorWindowMathV1";
import { colorWindowRefuseV1 } from "./colorWindowV1";

const smooth=(value:number)=>{const t=Math.max(0,Math.min(1,value));return t*t*(3-2*t);};
/** Coverage only: never a source alpha value. The renderer multiplies it with the HSL key before node mixing. */
export function colorWindowCoverageV1(geometry: ColorWindowGeometryV1, x: number, y: number): number {
  if (![x,y].every(Number.isFinite)) colorWindowRefuseV1("COLOR_WINDOW_PARAMETERS",geometry.maskId);
  // Do this before inversion: a lost inverted track must not select the entire image.
  if (geometry.status==="lost") return 0;
  let coverage:number;
  if (geometry.kind==="linear_gradient") {
    const [a,b]=geometry.points,dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy);
    const distance=((x-a.x)*dx+(y-a.y)*dy)/length-length/2+geometry.expansionPx;
    coverage=smooth(.5+distance/(length+2*geometry.featherPx));
  } else {
    const distance=(geometry.kind==="ellipse"
      ? colorWindowEllipseDistanceV1(geometry.ellipseInverse!,x,y,geometry.ellipseCenterDepth!)
      : colorWindowPolygonDistanceV1(geometry.points,x,y))+geometry.expansionPx;
    coverage=geometry.featherPx>0?smooth(.5+distance/(2*geometry.featherPx)):distance>=0?1:0;
  }
  return geometry.opacity*(geometry.inverted?1-coverage:coverage);
}
