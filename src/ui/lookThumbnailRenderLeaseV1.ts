/** One thumbnail preparation/render job for this renderer session. Unmount alone
 * does not release it: the unchanged renderer signals async preparation plus
 * GPU cleanup are closed. A replaced/closed panel can only wait, never bypass. */
export function createLookThumbnailRenderLeaseV1(){let live:object|undefined;const listeners=new Set<()=>void>();return{acquire:()=>{if(live)return undefined;return live={};},release:(token:object)=>{if(token!==live)return false;live=undefined;for(const listener of listeners){try{listener();}catch{}}return true;},busy:()=>Boolean(live),subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};}};}
export const lookThumbnailRenderLeaseV1=createLookThumbnailRenderLeaseV1();
