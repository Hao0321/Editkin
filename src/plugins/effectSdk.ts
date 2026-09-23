export const gpuEffectOperationNames = [
  "gain",
  "invert",
  "grayscale",
  "saturation",
  "contrast",
  "tint",
  "posterize",
  "vignette",
  "hue_rotate",
  "lift_gamma_gain",
  "filmic_curve",
  "temperature_tint",
] as const;

export type GpuEffectOperationName = typeof gpuEffectOperationNames[number];
/** Parameter references are syntax-checked by the manifest schema before compilation. */
export type GpuEffectArgument = number | string;

export interface GpuEffectModuleNode {
  id: string;
  input: "$source" | string;
  op: GpuEffectOperationName;
  args: GpuEffectArgument[];
}

export interface GpuEffectModule {
  schema: "editkin.gpu-effect-module/v1";
  nodes: GpuEffectModuleNode[];
  output: string;
}

export interface GpuEffectInstructionSpec {
  opcode: number;
  bounds: ReadonlyArray<readonly [number, number]>;
}

export const gpuEffectInstructionSpecs: Record<GpuEffectOperationName, GpuEffectInstructionSpec> = {
  gain: { opcode: 1, bounds: [[0, 8]] },
  invert: { opcode: 2, bounds: [[0, 1]] },
  grayscale: { opcode: 3, bounds: [[0, 1]] },
  saturation: { opcode: 4, bounds: [[0, 4]] },
  contrast: { opcode: 5, bounds: [[0, 4], [0, 1]] },
  tint: { opcode: 6, bounds: [[0, 2], [0, 2], [0, 2]] },
  posterize: { opcode: 7, bounds: [[2, 64]] },
  vignette: { opcode: 8, bounds: [[0, 1], [0, 1.5], [0.001, 1]] },
  hue_rotate: { opcode: 9, bounds: [[-3.141593, 3.141593]] },
  lift_gamma_gain: { opcode: 10, bounds: [[-0.5, 0.5], [0.1, 4], [0, 4]] },
  filmic_curve: { opcode: 11, bounds: [[0, 1], [0, 1], [0, 1]] },
  temperature_tint: { opcode: 12, bounds: [[-1, 1], [-1, 1]] },
};

/**
 * Compiles the public, data-only authoring graph to the closed runtime bytecode.
 * The graph is intentionally a unary color pipeline: no loops, recursion, texture bindings,
 * file/network access or arbitrary shader source can enter the resident GPU executor.
 */
export function compileGpuEffectModule(module: GpuEffectModule): GpuEffectModuleNode[] {
  if (module.schema !== "editkin.gpu-effect-module/v1") throw new Error("GPU effect module schema 不支援");
  if (module.nodes.length < 1 || module.nodes.length > 4) throw new Error("GPU effect module 必須包含 1 到 4 個節點");
  const nodes = new Map<string, GpuEffectModuleNode>();
  for (const node of module.nodes) {
    if (nodes.has(node.id)) throw new Error(`GPU effect module 節點 id 重複：${node.id}`);
    nodes.set(node.id, node);
  }
  if (!nodes.has(module.output)) throw new Error(`GPU effect module output 不存在：${module.output}`);

  const ordered: GpuEffectModuleNode[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`GPU effect module 不得形成循環：${id}`);
    if (visited.has(id)) return;
    const node = nodes.get(id);
    if (!node) throw new Error(`GPU effect module 引用不存在的節點：${id}`);
    visiting.add(id);
    if (node.input !== "$source") visit(node.input);
    visiting.delete(id);
    visited.add(id);
    ordered.push(node);
  };
  visit(module.output);
  if (visited.size !== nodes.size) {
    const orphaned = [...nodes.keys()].filter((id) => !visited.has(id));
    throw new Error(`GPU effect module 含未連到 output 的節點：${orphaned.join(", ")}`);
  }
  if (ordered[0]?.input !== "$source") throw new Error("GPU effect module 必須從 $source 開始");
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].input !== ordered[index - 1].id) throw new Error("GPU effect module 目前只允許單一路徑色彩節點");
  }
  return ordered;
}
