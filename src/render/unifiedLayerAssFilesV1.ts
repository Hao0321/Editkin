import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EditProject } from "../domain/types";
import { admitAssMotionProject, writeAssContent, type MotionAssOptions } from "./captionAss";
import { AssMotionBudget } from "./assMotionBudget";
import { createRenderWorkDirectory, removeRenderWorkDirectory } from "./renderWorkspace";
import { assertRenderActive } from "./renderLifetime";
import { assertUnifiedLayerCompositeProfileV1, buildUnifiedLayerCompositeOperationsV1, type UnifiedCompositeOperationV1 } from "./unifiedLayerCompositeV1";
import type { RenderPlan } from "./planner";

export type PreparedUnifiedCompositeOperationV1 = Exclude<UnifiedCompositeOperationV1, { kind: "ass" }>
  | (Extract<UnifiedCompositeOperationV1, { kind: "ass" }> & { assPath: string });

/** All bands share the canonical actual byte/sample/event budget and one owned D/output-drive work directory. */
export async function prepareUnifiedLayerAssFilesV1(project: EditProject, plan: RenderPlan, assSource: EditProject,
  options: MotionAssOptions, preserveAlpha: boolean, assStartFrame = 0) {
  if (project.unifiedLayerOrderV1 === undefined) return undefined;
  assertUnifiedLayerCompositeProfileV1(project, preserveAlpha);
  const aggregateBudget = options.aggregateBudget ?? new AssMotionBudget();
  admitAssMotionProject(assSource, assSource.captionStyle, { ...options, aggregateBudget });
  const operations = buildUnifiedLayerCompositeOperationsV1(project, plan, assSource, assStartFrame)!;
  const workspace = operations.some(operation => operation.kind === "ass") ? await createRenderWorkDirectory("editkin-render-") : undefined;
  let active = true;
  const dispose = async () => {
    if (!active) return;
    if (workspace) await removeRenderWorkDirectory(workspace);
    active = false;
  };
  try {
    const prepared: PreparedUnifiedCompositeOperationV1[] = [];
    for (const [index, operation] of operations.entries()) {
      assertRenderActive();
      if (operation.kind === "clip") { prepared.push(operation); continue; }
      const assPath = join(workspace!, `layer-band-${index}.ass`);
      const text = writeAssContent(operation.project, assSource.captionStyle, { ...options, aggregateBudget, compositeLayer: operation.compositeLayer });
      await writeFile(assPath, text, { encoding: "utf8", flag: "wx" });
      prepared.push({ ...operation, assPath });
    }
    return { operations: prepared, dispose };
  } catch (error) {
    try { await dispose(); } catch { /* Preserve the primary compile/write failure; canonical workspace ownership retains failed cleanup. */ }
    throw error;
  }
}
