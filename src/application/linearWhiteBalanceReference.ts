export interface LinearReferenceRoi { x: number; y: number; width: number; height: number }
export interface LinearWhiteBalanceReferenceFrame {
  sampleId: string; timeSeconds: number; width: number; height: number; pixels: Float32Array;
  roi: LinearReferenceRoi; reference: "caller-declared-neutral"; basis: "linear-rec709";
  inputConvention: "rec709-oetf" | "hlg-linear" | "pq-display-linear";
}
export interface LinearWhiteBalanceReferenceMeasurement extends Omit<LinearWhiteBalanceReferenceFrame, "pixels"> {
  pixelCount: number; meanLinearRgb: [number, number, number]; varianceLinearRgb: [number, number, number];
  meanLinearY: number; varianceLinearY: number; neutralErrorStops: number | null;
  nonPositiveCount: number; nonPositiveFraction: number; nonOpaqueCount: number; nonOpaqueFraction: number;
}
const weights = [.2126, .7152, .0722];
const maximum = 10000;
function invalid(): never { throw Error("Invalid explicit linear Rec709 reference measurement"); }
function geometry(f: Omit<LinearWhiteBalanceReferenceFrame,"pixels">) {
  if (!f || f.reference !== "caller-declared-neutral" || f.basis !== "linear-rec709"
    || !["rec709-oetf","hlg-linear","pq-display-linear"].includes(f.inputConvention)
    || typeof f.sampleId !== "string" || !f.sampleId.trim() || f.sampleId.length > 128 || !Number.isFinite(f.timeSeconds) || f.timeSeconds < 0
    || !Number.isSafeInteger(f.width) || !Number.isSafeInteger(f.height) || f.width < 1 || f.height < 1 || f.width > 256 || f.height > 256
    || !f.roi || ![f.roi.x,f.roi.y,f.roi.width,f.roi.height].every(v=>Number.isFinite(v)&&v>=0&&v<=1)
    || f.roi.width <= 0 || f.roi.height <= 0 || f.roi.x + f.roi.width > 1 || f.roi.y + f.roi.height > 1) invalid();
  const x0=Math.floor(f.roi.x*f.width),y0=Math.floor(f.roi.y*f.height);
  const x1=Math.min(f.width,Math.ceil((f.roi.x+f.roi.width)*f.width)),y1=Math.min(f.height,Math.ceil((f.roi.y+f.roi.height)*f.height));
  const count=(x1-x0)*(y1-y0); if(count<32)invalid();
  return {x0,y0,x1,y1,count};
}
const neutralError=(rgb:number[])=>rgb.some(v=>v<=0)?null:Math.log2(Math.max(...rgb))-Math.log2(Math.min(...rgb));
export function measureLinearWhiteBalanceReference(f:LinearWhiteBalanceReferenceFrame):LinearWhiteBalanceReferenceMeasurement {
  const g=geometry(f);
  if(!(f.pixels instanceof Float32Array)||f.pixels.length!==f.width*f.height*4
    ||(typeof SharedArrayBuffer!=="undefined"&&f.pixels.buffer instanceof SharedArrayBuffer))invalid();
  for(let i=0;i<f.pixels.length;i++)if(!Number.isFinite(f.pixels[i])||(i%4===3 ? f.pixels[i]<-1e-6||f.pixels[i]>1+1e-6 : Math.abs(f.pixels[i])>maximum))invalid();
  const mean=[0,0,0],m2=[0,0,0];let meanY=0,m2Y=0,n=0,nonPositiveCount=0,nonOpaqueCount=0;
  for(let y=g.y0;y<g.y1;y++)for(let x=g.x0;x<g.x1;x++) {
    const offset=(y*f.width+x)*4,rgb=[f.pixels[offset],f.pixels[offset+1],f.pixels[offset+2]];
    n++;if(rgb.some(v=>v<=0))nonPositiveCount++;if(Math.abs(f.pixels[offset+3]-1)>1e-6)nonOpaqueCount++;
    rgb.forEach((v,c)=>{const delta=v-mean[c];mean[c]+=delta/n;m2[c]+=delta*(v-mean[c]);});
    const luminance=rgb.reduce((v,c,i)=>v+c*weights[i],0),delta=luminance-meanY;meanY+=delta/n;m2Y+=delta*(luminance-meanY);
  }
  const result:LinearWhiteBalanceReferenceMeasurement={sampleId:f.sampleId,timeSeconds:f.timeSeconds,width:f.width,height:f.height,roi:{...f.roi},reference:f.reference,basis:f.basis,inputConvention:f.inputConvention,
    pixelCount:n,meanLinearRgb:mean as [number,number,number],varianceLinearRgb:m2.map(v=>Math.max(0,v/n)) as [number,number,number],
    meanLinearY:meanY,varianceLinearY:Math.max(0,m2Y/n),neutralErrorStops:neutralError(mean),nonPositiveCount,nonPositiveFraction:nonPositiveCount/n,nonOpaqueCount,nonOpaqueFraction:nonOpaqueCount/n};
  validateLinearWhiteBalanceReference(result);return result;
}
export function validateLinearWhiteBalanceReference(f:LinearWhiteBalanceReferenceMeasurement):void {
  const g=geometry(f);
  if(f.pixelCount!==g.count||!Array.isArray(f.meanLinearRgb)||f.meanLinearRgb.length!==3||!f.meanLinearRgb.every(v=>Number.isFinite(v)&&Math.abs(v)<=maximum)
    ||!Array.isArray(f.varianceLinearRgb)||f.varianceLinearRgb.length!==3||!f.varianceLinearRgb.every(v=>Number.isFinite(v)&&v>=0)
    ||!Number.isFinite(f.meanLinearY)||Math.abs(f.meanLinearY)>maximum||!Number.isFinite(f.varianceLinearY)||f.varianceLinearY<0)invalid();
  const y=f.meanLinearRgb.reduce((v,c,i)=>v+c*weights[i],0),error=neutralError(f.meanLinearRgb);
  if(Math.abs(f.meanLinearY-y)>1e-8*Math.max(1,Math.abs(y))||(error===null?f.neutralErrorStops!==null:typeof f.neutralErrorStops!=="number"||!Number.isFinite(f.neutralErrorStops)||Math.abs(f.neutralErrorStops-error)>1e-10))invalid();
  for(let c=0;c<3;c++)if(f.varianceLinearRgb[c]>maximum**2-f.meanLinearRgb[c]**2+1e-6)invalid();
  const weightedSd=f.varianceLinearRgb.map((v,i)=>Math.sqrt(v)*weights[i]),sdSum=weightedSd.reduce((a,b)=>a+b,0);
  const lower=Math.max(0,2*Math.max(...weightedSd)-sdSum)**2,upper=sdSum**2,tolerance=1e-8*Math.max(1,upper);
  if(f.varianceLinearY<lower-tolerance||f.varianceLinearY>upper+tolerance)invalid();
  for(const [count,fraction]of [[f.nonPositiveCount,f.nonPositiveFraction],[f.nonOpaqueCount,f.nonOpaqueFraction]])
    if(!Number.isSafeInteger(count)||count<0||count>g.count||!Number.isFinite(fraction)||Math.abs(fraction-count/g.count)>1e-12)invalid();
}
/** Caller declaration is not independently verified neutral truth. No upper-Y=1 HDR rejection. */
export function linearWhiteBalanceReferenceUnusable(f:LinearWhiteBalanceReferenceMeasurement):boolean {
  validateLinearWhiteBalanceReference(f);
  return f.meanLinearY<.02||f.neutralErrorStops===null||f.nonPositiveFraction>.02||f.nonOpaqueCount>0
    ||f.varianceLinearRgb.some((v,i)=>Math.sqrt(v)/Math.max(1e-12,f.meanLinearRgb[i])>.25)
    ||Math.sqrt(f.varianceLinearY)/Math.max(1e-12,f.meanLinearY)>.25;
}
