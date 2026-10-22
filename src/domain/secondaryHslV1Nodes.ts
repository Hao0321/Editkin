import type { ColorGradeNodeV2 } from "./visualTypes";

/** Existing loaders retain their old admission rules; this adds only active, explicit outside LUTs. */
export function secondaryHslSourceNodesV1(nodes: readonly ColorGradeNodeV2[]): ColorGradeNodeV2[] {
  return nodes.flatMap(node => {
    const selection = node.secondaryHslV1;
    if (!selection?.outside || selection.enabled === false || node.enabled === false || (node.mix ?? 1) === 0) return [node];
    return [node, { id: node.id, ...selection.outside, enabled: node.enabled, mix: node.mix }];
  });
}

/** A disabled selector has exactly the original bake key as well as original pixels. */
export function secondaryHslSourceForKeyV1(node: ColorGradeNodeV2): ColorGradeNodeV2 {
  if (node.secondaryHslV1?.enabled !== false) return node;
  const { secondaryHslV1: _selection, ...plain } = node;
  return plain;
}
