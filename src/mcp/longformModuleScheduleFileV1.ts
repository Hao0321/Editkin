import {readProject} from "./storage";
import {prepareLongformModuleScheduleV1} from "../application/longformModuleScheduleV1";
import type {LongformModuleScheduleRequestV1} from "../domain/longformModuleScheduleV1";
import {colorDigest} from "../application/materialColorSamplingRuntime";

export async function prepareLongformModuleScheduleFileV1(projectPath:string,input:LongformModuleScheduleRequestV1,signal?:AbortSignal){
  signal?.throwIfAborted();const project=await readProject(projectPath),before=colorDigest(project);
  const result=prepareLongformModuleScheduleV1(project,input,signal);signal?.throwIfAborted();
  if(colorDigest(await readProject(projectPath))!==before)throw Error("LONGFORM_MODULE_PROJECT_FILE_CHANGED");
  signal?.throwIfAborted();return result;
}
