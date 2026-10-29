import type { EditProject } from "./types";
import { projectVisualLayersV1, resolveUnifiedLayerOrderStateV1, type UnifiedLayerOrderV1, type UnifiedLayerProjectV1 } from "./unifiedLayerOrderV1";

const identity = (ref: { kind: string; id: string }) => `${ref.kind}\0${ref.id}`;

/** Index once for a long render. A window visits only its selected identities; no full-order scan per chunk. */
export function createUnifiedLayerScopeProjectorV1(project: EditProject): (scope: UnifiedLayerProjectV1) => UnifiedLayerOrderV1 | undefined {
  if (project.unifiedLayerOrderV1 === undefined) return () => undefined;
  const positions = new Map(resolveUnifiedLayerOrderStateV1(project, project.unifiedLayerOrderV1).map((ref, index) => [identity(ref), index]));
  return scope => {
    const seen = new Set<string>();
    const selected = projectVisualLayersV1(scope).map(({ kind, id }) => {
      const key = identity({ kind, id }), position = positions.get(key);
      if (position === undefined || seen.has(key)) throw new Error("UNIFIED_LAYER_SCOPE_IDENTITIES_INVALID");
      seen.add(key);
      return { kind, id, position };
    }).sort((a, b) => a.position - b.position);
    return { schema: "editkin.unified-layer-order/v1", layers: selected.map(({ kind, id }) => ({ kind, id })) };
  };
}
