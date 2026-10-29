import { colorLutDesktopEntryV1Schema } from "../domain/colorLutDesktopContractV1";
import { colorGradeLutRefV2Schema } from "../domain/colorGradeV2Schema";
import type { ColorGradeLutRefV2, ColorGradeV2 } from "../domain/visualTypes";
import type { ColorLutApiV1, ColorLutImportV1 } from "../desktop/colorLutApiV1";
import { secondaryHslSourceNodesV1 } from "../domain/secondaryHslV1Nodes";
import { parseCubeFile } from "./cubeLut";
import { exportColorGradeV2Cube } from "./gradeLutBake";
export function createColorLutClientV1(api: ColorLutApiV1) {
  // Only in-flight reads are shared. Settled text/cube values are not retained in this client.
  const pending = new Map<string,Promise<{text:string;cube:ReturnType<typeof parseCubeFile>}>>();
  const readCube = (ref: ColorGradeLutRefV2, space: "rec709_display" | "acescct") => {
    colorGradeLutRefV2Schema.parse(ref);const key=`${space}:${ref.sha256}`,old=pending.get(key);if(old)return old;
    const task=(async()=>{const text=await api.readColorLutV1(ref,space);if(typeof text!=="string"||text.length>64*1024*1024)throw new Error("LUT 內容超過 64 MiB 上限。");
      const bytes=new TextEncoder().encode(text);if(!bytes.length||bytes.length>64*1024*1024)throw new Error("LUT 內容超過 64 MiB 上限。");
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
      if(hash!==ref.sha256)throw new Error("LUT 內容或色彩空間與調色引用不符。");return{text,cube:parseCubeFile(text)};})();
    pending.set(key,task);void task.then(()=>pending.delete(key),()=>pending.delete(key));return task;
  };
  return {
    async list(offset=0){const page=await api.listColorLutsV1(offset,100);
      if(!Array.isArray(page.entries)||page.entries.length>100||!Number.isSafeInteger(page.total)||page.total<0||page.nextOffset!==undefined&&(!Number.isSafeInteger(page.nextOffset)||page.nextOffset<=offset))throw new Error("LUT 素材庫 metadata 不合法。");
      return{...page,entries:page.entries.map(e=>colorLutDesktopEntryV1Schema.parse(e))};},
    async pick(){const selected=await api.pickColorLutV1();if(selected&&(!/^[a-f0-9]{32}$/.test(selected.selectionId)||typeof selected.suggestedName!=="string"))throw new Error("請重新選擇 LUT 檔案。");return selected;},
    async import(request:ColorLutImportV1){const result=await api.importColorLutV1(request),entry=colorLutDesktopEntryV1Schema.parse(result.entry),ref=colorGradeLutRefV2Schema.parse(result.nodeReference);
      if(ref.id!==entry.id||ref.sha256!==entry.sha256)throw new Error("LUT 素材庫 metadata 不合法。");return{entry,nodeReference:ref};},
    readCube,read:async(ref:ColorGradeLutRefV2,space:"rec709_display"|"acescct")=>(await readCube(ref,space)).text,
    async exportGrade(grade:ColorGradeV2,space:"rec709_display"|"acescct",title:string){const cubes=new Map<string,ReturnType<typeof parseCubeFile>>();
      for(const node of secondaryHslSourceNodesV1(grade.nodes??[])){if(!node.lut||node.enabled===false||node.lut.strength<=0||cubes.has(node.lut.sha256))continue;cubes.set(node.lut.sha256,(await readCube(node.lut,space)).cube);}
      return exportColorGradeV2Cube(grade,space,title,ref=>{const cube=cubes.get(ref.sha256);if(!cube)throw new Error("LUT 素材庫找不到這個調色引用。");return cube;});},
  };
}
export type ColorLutClientV1 = ReturnType<typeof createColorLutClientV1>;
