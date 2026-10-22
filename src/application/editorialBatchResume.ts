import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { canonicalJson } from "../shared/canonicalJson";
import type { EditProject } from "../domain/types";
import { parseProject, readPrimaryProjectFileWithIdentityV1, writeProjectFileAtomic } from "./projectFiles";
import { readBoundedFile } from "../shared/boundedFile";

export async function batchFileSha256(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
function generationSha(project: EditProject) {
  const { revision: _revision, updatedAt: _updatedAt, ...content } = project;
  return createHash("sha256").update(canonicalJson(content)).digest("hex");
}
/** Existing origin receipt is the authority after a process/response loss, never a guessed project match. */
export async function readMaterializedEditorialProject(path: string, planSha256: string, deliverableId: string) {
  let origin;
  try { origin = JSON.parse((await readBoundedFile(`${path}.batch-origin.json`, 128 * 1024)).toString("utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (origin.schema !== "editkin.editorial-batch-origin/v1" || origin.planSha256 !== planSha256 || origin.deliverableId !== deliverableId
    || !/^[a-f0-9]{64}$/.test(origin.projectSha256 ?? "") || !/^[a-f0-9]{64}$/.test(origin.generationSha256 ?? "")) throw new Error(`${deliverableId} 的批次計畫或產生器已變更；請使用新的輸出資料夾`);
  const observed = await readPrimaryProjectFileWithIdentityV1(path);
  if (observed.fileIdentity.projectSha256 !== origin.projectSha256) throw new Error(`${deliverableId} 已經修改；重試不會覆蓋你的剪輯`);
  return { project: observed.project, fileIdentity: observed.fileIdentity, resumed: true, projectSha256: origin.projectSha256 as string, generationSha256: origin.generationSha256 as string };
}

export async function materializeEditorialProject(path: string, planSha256: string, deliverableId: string, generated: EditProject,
  options: { writeProject?: typeof writeProjectFileAtomic } = {}) {
  const originPath = `${path}.batch-origin.json`;
  let origin: { schema?: string; planSha256?: string; deliverableId?: string; projectSha256?: string; generationSha256?: string } | undefined;
  try { origin = JSON.parse(await readFile(originPath, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (origin) {
    if (origin.schema !== "editkin.editorial-batch-origin/v1" || origin.planSha256 !== planSha256 || origin.deliverableId !== deliverableId || origin.generationSha256 !== generationSha(generated)) {
      throw new Error(`${deliverableId} 的批次計畫或產生器已變更；請使用新的輸出資料夾`);
    }
    const observed = await readPrimaryProjectFileWithIdentityV1(path);
    if (observed.fileIdentity.projectSha256 !== origin.projectSha256) throw new Error(`${deliverableId} 已經修改；重試不會覆蓋你的剪輯`);
    return { project: observed.project, fileIdentity: observed.fileIdentity, resumed: true, projectSha256: origin.projectSha256 };
  }
  const project = await (options.writeProject ?? writeProjectFileAtomic)(path, generated, null, { createOnly: true });
  // The writer's reply describes the graph that this job actually committed.
  // A human may have replaced/edited the path before origin creation. Never
  // attribute those newer bytes to this job's older generated graph.
  const observed = await readPrimaryProjectFileWithIdentityV1(path);
  const currentProject = observed.project;
  if (canonicalJson(currentProject) !== canonicalJson(parseProject(project))) {
    throw new Error(`${deliverableId} 在建立批次來源收據前已被修改；保留目前檔案，請使用新的輸出資料夾`);
  }
  const projectSha256 = observed.fileIdentity.projectSha256;
  // Exclusive origin creation: a crash before this point leaves protected bytes,
  // never permission to infer ownership and overwrite an unreceipted project.
  await writeFile(originPath, JSON.stringify({ schema: "editkin.editorial-batch-origin/v1", planSha256, deliverableId,
    projectSha256, generationSha256: generationSha(generated) }, null, 2), { flag: "wx" });
  return { project, fileIdentity: observed.fileIdentity, resumed: false, projectSha256 };
}

export async function readEditorialRenderReceipt(receiptPath: string, outputPath: string, projectSha256: string) {
  let receipt;
  try { receipt = JSON.parse(await readFile(receiptPath, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (receipt.schema !== "editkin.editorial-render/v1" || receipt.projectSha256 !== projectSha256 ||
      receipt.outputSha256 !== await batchFileSha256(outputPath)) throw new Error("已完成輸出或專案已變更；不重用、不覆蓋失效成片");
  return receipt as { schema: string; projectSha256: string; outputSha256: string; duration: number; encoder: string };
}
