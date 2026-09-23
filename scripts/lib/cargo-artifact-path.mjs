import { dirname, resolve } from "node:path";

export function resolveCargoReleaseBinary({
  cwd,
  manifestPath,
  binaryName,
  platform,
  cargoTargetDir,
}) {
  if (!cwd) throw new Error("cwd is required");
  if (!manifestPath) throw new Error("manifestPath is required");
  if (!binaryName) throw new Error("binaryName is required");

  const targetDirectory = typeof cargoTargetDir === "string" && cargoTargetDir.length > 0
    ? resolve(cwd, cargoTargetDir)
    : resolve(cwd, dirname(manifestPath), "target");
  const suffix = platform === "win32" ? ".exe" : "";
  return resolve(targetDirectory, "release", `${binaryName}${suffix}`);
}
