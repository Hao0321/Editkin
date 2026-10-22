import { resolve } from "node:path";

/** Shorts are owned children of the workspace. Default temporary work is on that output drive. */
export function shortRenderWorkDirectory(workspace: string, environment: NodeJS.ProcessEnv): string {
  return environment.EDITKIN_RENDER_WORK_ROOT?.trim() || resolve(workspace);
}
