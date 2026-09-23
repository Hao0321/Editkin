import { lstat, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export const EXTERNAL_AUTO_ROTO_RESOURCE_PATTERN = /(?:^|[\\/._-])(?:auto[\\/._-]?roto|sam(?:2|21)|segment[\\/._-]?anything(?:[\\/._-]?2)?|onnx(?:runtime)?|checkpoint|weights?|hiera|pytorch(?:[\\/._-]?model)?|site-packages|python(?:\d+(?:\.dll)?|\.exe)?|torch(?:vision)?|numpy|pillow|hydra|omegaconf|iopath|cuda(?:\d+)?|cudnn(?:\d+)?)(?:$|[\\/._-])|\.(?:py|pyc|pt|pth|ckpt|onnx|ort|tflite|safetensors|engine|plan)$/i;

export function externalAutoRotoResourceFindings(paths) {
  return [...new Set(paths.map((path) => String(path).replaceAll("\\", "/")).filter((path) => EXTERNAL_AUTO_ROTO_RESOURCE_PATTERN.test(path)))].sort();
}

export function assertSelfAuthoredProductResources(paths, label = "product resources") {
  const findings = externalAutoRotoResourceFindings(paths);
  if (findings.length) {
    throw new Error(`${label} 含外部 Auto Roto runtime／model artifact：${findings.join(", ")}`);
  }
  return { status: "GREEN_SELF_AUTHORED_RESOURCES", paths: paths.length, findings };
}

export async function inventoryProductResourceRoots(roots, base = process.cwd()) {
  const resolvedBase = resolve(base);
  const inventory = [];
  async function visit(path) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Product resources reject symlink: ${relative(resolvedBase, path)}`);
    if (info.isFile()) {
      inventory.push(relative(resolvedBase, path).replaceAll("\\", "/"));
      return;
    }
    if (!info.isDirectory()) throw new Error(`Product resources reject non-file entry: ${relative(resolvedBase, path)}`);
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error(`Product resources reject symlink: ${relative(resolvedBase, join(path, entry.name))}`);
      await visit(join(path, entry.name));
    }
  }
  for (const root of roots) await visit(resolve(resolvedBase, root));
  return inventory.sort();
}

export async function assertSelfAuthoredProductResourceRoots(roots, label = "product resource roots", base = process.cwd()) {
  const inventory = await inventoryProductResourceRoots(roots, base);
  return { ...assertSelfAuthoredProductResources(inventory, label), inventory };
}

export function tauriResourcePaths(config) {
  return Object.entries(config?.bundle?.resources ?? {}).flatMap(([source, destination]) => [source, destination]);
}
