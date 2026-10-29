import { useRef } from "react";
import type { ColorLutApiV1 } from "../desktop/colorLutApiV1";
import { createColorLutClientV1 } from "../color/colorLutClientV1";
export function useColorLutClientV1(space:"rec709_display"|"acescct",explicit?: ColorLutApiV1) {
  const api=explicit??(typeof window==="undefined"?undefined:window.haoDesktop);
  const ref=useRef<{api:typeof api;space:typeof space;client?:ReturnType<typeof createColorLutClientV1>;readLut?:(r:import('../domain/visualTypes').ColorGradeLutRefV2)=>Promise<string>}>(undefined);
  if(!ref.current||ref.current.api!==api||ref.current.space!==space){const client=api?.listColorLutsV1&&api.pickColorLutV1&&api.importColorLutV1&&api.readColorLutV1?createColorLutClientV1(api as ColorLutApiV1):undefined;ref.current={api,space,client,readLut:client?r=>client.read(r,space):undefined};}
  return ref.current;
}
