import { readProject } from "./storage";
import { withReferenceMotionPhysicalFonts } from "./referenceMotionPhysicalFonts";
import { prepareMotionGraphicCreation, type MotionGraphicCreationInput } from "../application/motionGraphicCreation";
import { canonicalJson } from "../shared/canonicalJson";

/** Real project and verified bundled-font ingress; preparation never writes. */
export async function prepareMotionGraphicCreationFile(projectPath: string, input: MotionGraphicCreationInput,
  environment: NodeJS.ProcessEnv = process.env, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const project = await readProject(projectPath);
  const projectPin = canonicalJson(project);
  const result = await withReferenceMotionPhysicalFonts(dependencies => {
    if (!dependencies.prepareText) throw new Error("新增圖文缺少實體字型準備介面");
    return prepareMotionGraphicCreation(project, input, { prepareText: dependencies.prepareText, signal });
  }, environment, signal);
  signal?.throwIfAborted();
  if (canonicalJson(await readProject(projectPath)) !== projectPin) throw new Error("準備期間專案檔已變更，請重新讀取後再新增圖文");
  signal?.throwIfAborted();
  return result;
}
