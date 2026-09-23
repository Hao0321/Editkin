import { resolve } from "node:path";
import { runOwnedProcess } from "./owned-process-runner.mjs";

export const PRODUCT_CARGO_MANIFESTS = Object.freeze([
  "native/hao-core/Cargo.toml",
  "spikes/gpu-compositor/Cargo.toml",
  "src-tauri/Cargo.toml",
]);

// Resolve dependencies without compiling, downloading, or rewriting any lock.
// Run before expensive asset generation so a stale consumer lock fails early.
export async function assertProductCargoLocks({ root, cargo, run = runOwnedProcess }) {
  const checked = [];
  for (const manifest of PRODUCT_CARGO_MANIFESTS) {
    let child;
    try {
      child = await run(cargo, [
        "tree", "--locked", "--offline", "--no-default-features", "--depth", "0",
        "--manifest-path", resolve(root, manifest),
      ], { cwd: root, timeoutMs: 30_000 });
      if (child.code !== 0 || !child.closed || child.signal || child.timedOut || !child.stdout?.trim()) {
        throw Object.assign(new Error("Cargo did not return a complete dependency graph"), { result: child });
      }
    } catch (cause) {
      throw Object.assign(new Error(`Cargo lock preflight failed for ${manifest}: ${cause.message}`, { cause }), {
        manifest, result: cause.result ?? child,
      });
    }
    checked.push({ manifest, ...child });
  }
  return checked;
}
