import type { EditProject } from "../domain/types";
import { prepareAutoReframeSourceV1 } from "./autoReframeSourceV1";
import { createAutoReframeSparseV2, type SparseReframeInputV2 } from "./autoReframeSparseV2";
/** Reuses the authentic bounded source producer; only the explicitly selected camera sink changes. */
export async function prepareAutoReframeSparseSourceV2(project: EditProject, input: SparseReframeInputV2 & { expectedSourceSha256: string }, runtime: Parameters<typeof prepareAutoReframeSourceV1>[2]) {
  const sparseCameraV2 = createAutoReframeSparseV2(project, input);
  const prepared = await prepareAutoReframeSourceV1(project, input, { ...runtime, sparseCameraV2 });
  if (prepared.schema !== "editkin.auto-reframe-preparation/v2") throw Error("REFRAME_SPARSE_SOURCE_PROTOCOL_CHANGED");
  return prepared;
}
