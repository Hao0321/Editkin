import { createEmptyProject } from "../domain/editGraph";
import { withAcesPhonePolicyV1 } from "../color/acesPhoneInputV1";

/** Actual user New Project entry; certified template factories retain createEmptyProject's original recipe. */
export function createPhoneProjectV1(...args: Parameters<typeof createEmptyProject>): ReturnType<typeof createEmptyProject> {
  const project = createEmptyProject(...args);
  project.colorManagement = withAcesPhonePolicyV1(project.colorManagement!);
  return project;
}
