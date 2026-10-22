export interface PreviewFrameIdentityV1 {pipelineKey:string;primaryKey:string;sourceTime?:number}
export const previewFramePipelineKeyV1=(value:{asset:unknown;source:string;grade?:unknown;management:unknown;rec709Input?:string;ownerKey?:string})=>JSON.stringify(value);
const owners=new WeakMap<object,number>();let nextOwner=0;
export function previewPickerOwnerKeyV1(clipId:string,scope?:{owner:object;sessionId:number}){let owner=0;if(scope){owner=owners.get(scope.owner)??++nextOwner;owners.set(scope.owner,owner);}return JSON.stringify([clipId,owner,scope?.sessionId]);}
export function previewPickerPointV1(size:{width:number;height:number},rect:{left:number;top:number;width:number;height:number},point:{x:number;y:number},insets:{left:number;right:number;top:number;bottom:number}={left:0,right:0,top:0,bottom:0}){
  if(![size.width,size.height].every(v=>Number.isSafeInteger(v)&&v>0&&v<=32768)||![rect.left,rect.top,rect.width,rect.height,point.x,point.y,...Object.values(insets)].every(Number.isFinite)||Object.values(insets).some(v=>v<0))throw Error('取色座標或影像尺寸不合法。');
  const width=rect.width-insets.left-insets.right,height=rect.height-insets.top-insets.bottom;if(width<=0||height<=0)throw Error('取色座標或影像尺寸不合法。');
  const scale=Math.min(width/size.width,height/size.height),left=rect.left+insets.left+(width-size.width*scale)/2,top=rect.top+insets.top+(height-size.height*scale)/2;
  const x=(point.x-left)/scale,y=(point.y-top)/scale;if(x<0||y<0||x>=size.width||y>=size.height)return undefined;return{x:Math.floor(x),y:Math.floor(y)};
}
export function previewPickerPatchV1(width:number,height:number,x:number,y:number,side:number){
  if(![width,height].every(v=>Number.isSafeInteger(v)&&v>0&&v<=32768)||![x,y].every(Number.isInteger)||x<0||x>=width||y<0||y>=height||![1,3,5,9].includes(side))throw Error('取色範圍不合法。');
  const radius=(side-1)/2,left=Math.max(0,x-radius),top=Math.max(0,y-radius);return{x:left,y:top,width:Math.min(width,x+radius+1)-left,height:Math.min(height,y+radius+1)-top};
}
export function previewPickerValuesV1(pixels:Uint8ClampedArray){
  if(!(pixels instanceof Uint8ClampedArray)||!pixels.length||pixels.length%4||pixels.length>324)throw Error('取色像素資料不合法。');
  const sums=[0,0,0];let weight=0,validPixels=0;for(let i=0;i<pixels.length;i+=4){const alpha=pixels[i+3]/255;if(alpha<16/255)continue;for(let c=0;c<3;c++)sums[c]+=pixels[i+c]*alpha;weight+=alpha;validPixels++;}
  if(!weight)throw Error('這個位置沒有可取樣的不透明像素。');const rgb=sums.map(v=>Math.round(v/weight)) as [number,number,number],values=rgb.map(v=>v/255),max=Math.max(...values),min=Math.min(...values),delta=max-min,lightness=(max+min)/2;
  let hue:number|null=null;if(delta){const [r,g,b]=values;hue=((max===r?(g-b)/delta:max===g?(b-r)/delta+2:(r-g)/delta+4)*60+360)%360;}
  const saturation=delta?delta/(1-Math.abs(2*lightness-1)):0;return{rgb,hex:'#'+rgb.map(v=>v.toString(16).padStart(2,'0')).join('').toUpperCase(),hueDegrees:hue,saturation,lightness,validPixels};
}
export function samePreviewFrameV1(a:PreviewFrameIdentityV1,b:PreviewFrameIdentityV1){return a.pipelineKey===b.pipelineKey&&a.primaryKey===b.primaryKey&&(a.sourceTime===undefined?b.sourceTime===undefined:b.sourceTime!==undefined&&Number.isFinite(a.sourceTime)&&Number.isFinite(b.sourceTime)&&Math.abs(a.sourceTime-b.sourceTime)<1e-4);}
