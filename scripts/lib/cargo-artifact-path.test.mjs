import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveCargoReleaseBinary } from "./cargo-artifact-path.mjs";
import { NATIVE_CORE_BUILD_INPUT_ROOTS } from "./native-shared-inputs.mjs";

const cwd = resolve("fixture-repo");
const manifestPath = "spikes/gpu-compositor/Cargo.toml";
const binaryName = "editkin-gpu-compositor";

test("uses the manifest-local Cargo target directory when CARGO_TARGET_DIR is unset", () => {
  assert.equal(
    resolveCargoReleaseBinary({ cwd, manifestPath, binaryName, platform: "linux" }),
    resolve(cwd, "spikes/gpu-compositor/target/release/editkin-gpu-compositor"),
  );
});

test("uses a relative CARGO_TARGET_DIR from Cargo's working directory", () => {
  const actual = resolveCargoReleaseBinary({
    cwd,
    manifestPath,
    binaryName,
    platform: "win32",
    cargoTargetDir: "src-tauri/target",
  });
  const legacyHardCodedPath = resolve(cwd, "spikes/gpu-compositor/target/release/editkin-gpu-compositor.exe");

  assert.equal(actual, resolve(cwd, "src-tauri/target/release/editkin-gpu-compositor.exe"));
  assert.notEqual(actual, legacyHardCodedPath);
});

test("preserves an absolute CARGO_TARGET_DIR and native executable suffix", () => {
  const absoluteTarget = resolve("isolated-cargo-target");
  assert.equal(
    resolveCargoReleaseBinary({
      cwd,
      manifestPath,
      binaryName,
      platform: "darwin",
      cargoTargetDir: absoluteTarget,
    }),
    resolve(absoluteTarget, "release/editkin-gpu-compositor"),
  );
});

test("both Tauri frontend Cargo helpers honor the shared target resolver", async () => {
  for (const path of ["../build-native-core.mjs", "../build-gpu-compositor.mjs"]) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.match(source, /resolveCargoReleaseBinary/u, path);
    assert.match(source, /cargoTargetDir:\s*process\.env\.CARGO_TARGET_DIR/u, path);
    if (path.includes("build-native-core")) {
      assert.match(source, /NATIVE_CORE_BUILD_INPUT_ROOTS/u, "native producer must use the shared receipt input inventory");
      assert.ok(NATIVE_CORE_BUILD_INPUT_ROOTS.includes("scripts/lib/cargo-artifact-path.mjs"),
        "native receipt input inventory must bind the target resolver");
    }
  }
});
