import { migrateProject, validateProject } from "../domain/editGraph";
import { projectSchema } from "../domain/schema";
import type { EditProject } from "../domain/types";
import { resolveAestheticSystem } from "./editkinAesthetic";
import { dehydrateAutoRotoFramePreviews } from "../domain/autoRotoPreviewProjection";

export const PROJECT_MAX_BYTES = 64 * 1024 * 1024;

/** The same graph parser is used by desktop files and browser-selected files. */
export function parseProject(input: unknown): EditProject {
  const project = dehydrateAutoRotoFramePreviews(validateProject(projectSchema.parse(migrateProject(input))));
  project.aestheticSystem ??= resolveAestheticSystem(project.editorialProfile, project.width > project.height ? "longform" : "shorts");
  return validateProject(project);
}

export function decodeProjectBytes(bytes: Uint8Array): EditProject {
  if (bytes.byteLength > PROJECT_MAX_BYTES) throw new Error("專案檔超過 64 MiB 上限，拒絕讀取");
  return parseProject(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
}

export function encodeProjectBytes(project: EditProject): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(parseProject(project), null, 2));
  if (bytes.byteLength > PROJECT_MAX_BYTES) throw new Error("專案檔超過 64 MiB 上限，拒絕下載");
  return bytes;
}
