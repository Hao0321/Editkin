import type { EditorCommand } from "../domain/commands";
import type { EditProject, EditorialProfileId } from "../domain/types";
import { resolveAestheticSystem } from "../application/editkinAesthetic";
import { readCreatorReviewPolicy, assertCreatorReviewPolicyCurrent } from "./creatorReviewPolicy";
import { createProjectFile } from "./storage";

/** The create_project body: a new workspace project with its editorial profile and the anonymous aesthetic
 * standard bound to the current creator review policy, re-checked just before the file is committed.
 * `createOnly` refuses, inside the project save lock, to replace an existing or recoverable (.previous) project. */
export async function createEditorialProjectFile(projectPath: string, name: string, width: number, height: number, fps: number,
  profile: EditorialProfileId, colorPipeline?: "rec709" | "aces2", options: { createOnly?: boolean } = {}): Promise<EditProject> {
  const reviewPolicy = await readCreatorReviewPolicy();
  const commands: EditorCommand[] = [
    { type: "set_editorial_profile", profile },
    { type: "set_aesthetic_system", aestheticSystem: resolveAestheticSystem(profile, width > height ? "longform" : "shorts", reviewPolicy.policy) },
  ];
  if (colorPipeline === "aces2") commands.push({ type: "set_project_color_management", patch: { mode: "aces2", outputTransform: "rec709_sdr", rec709DisplayPolicy: "phone-bt1886" } });
  await assertCreatorReviewPolicyCurrent(reviewPolicy);
  return createProjectFile(projectPath, name, width, height, fps, commands, () => assertCreatorReviewPolicyCurrent(reviewPolicy), options);
}
