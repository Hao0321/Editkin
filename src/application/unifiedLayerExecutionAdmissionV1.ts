import type { EditProject } from "../domain/types";
import { selectReferencedCompositionsForRenderV1 } from "../render/referencedCompositionPrepassV1";
import { assertUnifiedLayerCompositeProfileV1 } from "../render/unifiedLayerCompositeV1";
import { HIGH_BIT_DEPTH_ALPHA_PROFILE } from "../render/ffmpegContracts";

/** Only the root and reachable compositions affect its picture; unused library entries are not execution state. */
export function hasExecutableUnifiedLayerOrderV1(project: EditProject): boolean {
  if (project.unifiedLayerOrderV1 !== undefined) return true;
  if (!project.compositions?.some(composition => composition.unifiedLayerOrderV1 !== undefined)) return false;
  return selectReferencedCompositionsForRenderV1(project).compositions.some(composition => composition.unifiedLayerOrderV1 !== undefined);
}

/** The generic Rec.709 composite consumes saved root order. Unadopted group/colour/alpha routes must not fall back. */
export function assertUnifiedLayerFormalExportAdmissionV1(project: EditProject, options: { deliveryProfile?: string } = {}): void {
  if (!hasExecutableUnifiedLayerOrderV1(project)) return;
  if (!project.unifiedLayerOrderV1 || selectReferencedCompositionsForRenderV1(project).compositions.some(composition => composition.unifiedLayerOrderV1 !== undefined)) throw Object.assign(
    new Error("此專案的混合圖層排序尚未支援正式輸出；已停止輸出，避免圖層順序改變。"),
    { code: "UNIFIED_LAYER_FORMAL_EXPORT_NOT_ADOPTED" },
  );
  assertUnifiedLayerCompositeProfileV1(project, options.deliveryProfile === HIGH_BIT_DEPTH_ALPHA_PROFILE);
}
