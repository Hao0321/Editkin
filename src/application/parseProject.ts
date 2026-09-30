import { migrateProject, validateProject } from "../domain/editGraph";
import { projectSchema } from "../domain/schema";
import type { EditProject } from "../domain/types";
import { resolveAestheticSystem } from "./editkinAesthetic";
import { dehydrateAutoRotoFramePreviews } from "../domain/autoRotoPreviewProjection";

// Kept free of node:* imports so the browser build can validate project files too.
export function parseProject(input: unknown): EditProject {
  const project = dehydrateAutoRotoFramePreviews(validateProject(projectSchema.parse(migrateProject(input))));
  project.aestheticSystem ??= resolveAestheticSystem(project.editorialProfile, project.width > project.height ? "longform" : "shorts");
  return validateProject(project);
}
