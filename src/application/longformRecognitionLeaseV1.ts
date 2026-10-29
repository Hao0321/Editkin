import { resolve } from "node:path";

const active=new Map<string,symbol>();
/** Word and sentence jobs share immutable acoustic window files. Keep a
 * single writer for each cache until its owned preparation has settled. */
export function claimLongformRecognitionLeaseV1(cacheRoot:string){
  const absolute=resolve(cacheRoot),key=process.platform==="win32"?absolute.toLowerCase():absolute;
  if(active.has(key))throw new Error("LONGFORM_RECOGNITION_ALREADY_RUNNING");
  const token=Symbol();active.set(key,token);let released=false;
  return()=>{if(!released&&active.get(key)===token){active.delete(key);released=true;}};
}
