import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { isAbsolute, parse, resolve } from "node:path";
import contract from "../../config/windows-gpu-build-inputs.json" with { type: "json" };
import { fileIdentity, readRegularFile } from "./regular-file.mjs";

const base = "spikes/gpu-compositor/";
const headers = `${base}vendor/ffmpeg-8.1-lgpl/include/`;
const metadata = new Set([
  `${base}fixtures/software-video/ffmpeg-lgpl-runtime-rd.json`,
  `${base}vendor/ffmpeg-8.1-lgpl/LICENSE.txt`, `${base}vendor/ffmpeg-8.1-lgpl/README.md`,
]);
const code = [`${base}build.rs`, `${base}src/software_video_bridge.cpp`, `${base}src/software_video_bridge.h`];
if (contract.schema !== "editkin.windows-gpu-compile-contract/v1" || contract.scope !== "compile-only; never-release-resources"
    || contract.headerCount !== 144 || !Array.isArray(contract.files) || contract.files.length !== 147)
  throw new Error("Invalid Windows GPU compile-only contract");
const pins = new Map();
for (const row of contract.files) {
  const name = row?.path;
  if (typeof name !== "string" || isAbsolute(name) || name.includes("\\")
      || !/^[a-z0-9._/-]+$/iu.test(name) || name.split("/").some(part => !part || part === "." || part === "..")
      || !(metadata.has(name) || name.startsWith(headers) && name.endsWith(".h"))
      || !Number.isSafeInteger(row.bytes) || row.bytes <= 0 || !/^[a-f0-9]{64}$/u.test(row.sha256)
      || [...pins.keys()].some(path => path.toLowerCase() === name.toLowerCase()))
    throw new Error("Unsafe, duplicate or binary GPU compile input");
  pins.set(name, Object.freeze({ bytes: row.bytes, sha256: row.sha256 }));
}
if ([...pins.keys()].filter(name => name.startsWith(headers)).length !== 144
    || [...metadata].some(name => !pins.has(name))) throw new Error("Incomplete GPU compile-only contract");
export const WINDOWS_GPU_COMPILE_INPUT_PATHS = Object.freeze([...code, ...pins.keys()].sort());

export async function captureWindowsGpuCompileInputs({ root: rootInput, assertRegularAncestry }) {
  const root = resolve(rootInput), names = [];
  async function walk(directory) {
    for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
      const name = `${directory}${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`GPU compile input rejects link/junction: ${name}`);
      if (entry.isDirectory()) await walk(`${name}/`);
      else if (entry.isFile() && pins.has(name) && name.endsWith(".h")) names.push(name);
      else throw new Error(`Unexpected GPU header entry: ${name}`);
    }
  }
  // Validate ancestors before directory discovery; the first pinned leaf also
  // makes a missing header tree fail before any quality, asset or Cargo child.
  await assertRegularAncestry(parse(root).root, resolve(root, `${headers}libavcodec/avcodec.h`));
  await walk(headers);
  if (names.length !== 144 || new Set(names).size !== 144) throw new Error("Incomplete Windows GPU header inventory");
  const files = [];
  for (const name of WINDOWS_GPU_COMPILE_INPUT_PATHS) {
    const path = resolve(root, name);
    await assertRegularAncestry(root, path);
    const identity = await fileIdentity(path), pin = pins.get(name);
    if (pin && (identity.bytes !== pin.bytes || identity.sha256 !== pin.sha256))
      throw new Error(`Pinned GPU compile input changed: ${name}`);
    files.push({ path: name, ...identity });
  }
  const runtime = JSON.parse((await readRegularFile(resolve(root, `${base}fixtures/software-video/ffmpeg-lgpl-runtime-rd.json`))).toString("utf8"));
  if (runtime.schema !== "editkin.ffmpeg-lgpl-runtime/v1" || runtime.distributionScope !== "rd-only-not-for-package"
      || runtime.shippingEligible !== false) throw new Error("GPU compile prerequisite changed its nonshipping boundary");
  return { scope: "windows-gpu-compile-sources; never-release-resources", files,
    identity: createHash("sha256").update(JSON.stringify(files)).digest("hex") };
}
