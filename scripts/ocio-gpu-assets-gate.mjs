import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const gpuRoot = resolve(root, "public", "color", "aces2", "gpu");
const evidenceRoot = resolve(root, ".rd", "benchmarks", "p1-ocio-gpu-assets");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

const indexBytes = await readFile(resolve(gpuRoot, "index.json"));
const index = JSON.parse(indexBytes);
const cpuReference = JSON.parse(await readFile(resolve(gpuRoot, "cpu-reference.json"), "utf8"));
const gradeCpuReference = JSON.parse(await readFile(resolve(gpuRoot, "grade-cpu-reference.json"), "utf8"));
const expectedKeys = new Set([
  "input:rec709", "input:srgb", "input:hlg", "input:pq", "input:acescct", "input:apple_log",
  "input:arri_logc3", "input:arri_logc4", "input:bmd_film_gen5", "input:canon_log2", "input:canon_log3",
  "input:dji_dlog", "input:panasonic_vlog", "input:red_log3g10", "input:sony_slog3_cine",
  "grade:primary-tone",
  "output:rec709_sdr", "output:p3d65_sdr", "output:rec2100_hlg_1000", "output:rec2100_pq_1000",
]);
const stages = [];
for (const definition of index.generated ?? []) {
  const bytes = await readFile(resolve(gpuRoot, definition.file));
  const value = JSON.parse(bytes);
  const textures = value.textures ?? [];
  const uniforms = value.uniforms ?? [];
  stages.push({
    stage: value.stage,
    key: value.key,
    cacheId: value.cacheId,
    sha256Matches: hash(bytes) === definition.sha256,
    schemaMatches: value.schema === "editkin.ocio-gpu-stage/v1",
    languageBoundary: !value.shaderText.includes("#version") && value.shaderText.includes(value.functionName),
    texturesValid: textures.every((texture) => [1, 3].includes(texture.channels)
      && texture.width > 0 && texture.height > 0
      && texture.values.length === texture.width * texture.height * texture.channels
      && texture.values.every(Number.isFinite)),
    uniformsValid: uniforms.every((uniform) => ["bool", "float", "vec3"].includes(uniform.type)
      && typeof uniform.name === "string" && uniform.name.length > 0
      && (typeof uniform.default === "boolean" || Number.isFinite(uniform.default)
        || (Array.isArray(uniform.default) && uniform.default.length === 3 && uniform.default.every(Number.isFinite)))),
    shaderBytes: value.shaderText.length,
    textureValues: textures.reduce((total, texture) => total + texture.values.length, 0),
  });
}
const actualKeys = new Set(stages.map((stage) => `${stage.stage}:${stage.key}`));
const checks = {
  schema: index.schema === "editkin.ocio-gpu-index/v1",
  ocioVersionPinned: index.ocioVersion === "2.5.2",
  configPinned: index.configSha256 === "eda5b0008a43b72b98ad540e32eb0eb83b340dde54e35bddba64ccbafac1029a",
  twentyStages: stages.length === 20,
  exactStageCoverage: expectedKeys.size === actualKeys.size && [...expectedKeys].every((key) => actualKeys.has(key)),
  hashesMatch: stages.every((stage) => stage.sha256Matches),
  schemasMatch: stages.every((stage) => stage.schemaMatches),
  shaderAssemblySafe: stages.every((stage) => stage.languageBoundary),
  texturesValid: stages.every((stage) => stage.texturesValid),
  uniformsValid: stages.every((stage) => stage.uniformsValid),
  cpuReferencePinned: cpuReference.schema === "editkin.ocio-cpu-reference/v1"
    && cpuReference.ocioVersion === index.ocioVersion
    && cpuReference.configSha256 === index.configSha256
    && cpuReference.input === "rec709" && cpuReference.output === "rec709_sdr"
    && cpuReference.sourceRgba8.length === 4 && cpuReference.expectedRgba8.length === 4
    && [...cpuReference.sourceRgba8, ...cpuReference.expectedRgba8].every((value) => Number.isInteger(value) && value >= 0 && value <= 255),
  gradeCpuReferencePinned: gradeCpuReference.schema === "editkin.ocio-grade-cpu-reference/v1"
    && gradeCpuReference.ocioVersion === index.ocioVersion
    && gradeCpuReference.configSha256 === index.configSha256
    && gradeCpuReference.gradeCacheId === stages.find((item) => item.stage === "grade")?.cacheId
    && Object.values(gradeCpuReference.grade ?? {}).every(Number.isFinite)
    && gradeCpuReference.sourceRgba8.length === 4 && gradeCpuReference.expectedRgba8.length === 4
    && [...gradeCpuReference.sourceRgba8, ...gradeCpuReference.expectedRgba8].every((value) => Number.isInteger(value) && value >= 0 && value <= 255),
};
const decision = Object.values(checks).every(Boolean) ? "GREEN" : "BLOCK";
const report = {
  schema: "editkin.ocio-gpu-assets-gate/v1",
  decision,
  checks,
  indexSha256: hash(indexBytes),
  cpuReference,
  gradeCpuReference,
  stages,
  claimBoundary: "Proves pinned OCIO 2.5.2 GPU-stage generation, dynamic primary/tone uniform metadata, asset integrity and complete supported input/output coverage. Browser GPU compilation plus baseline and non-neutral graded pixels are gated by the Tauri CDP smoke; unified native wgpu float preview/export execution, adjustment/creative effects and HDR remain separate obligations.",
};
await mkdir(evidenceRoot, { recursive: true });
await writeFile(resolve(evidenceRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
if (decision !== "GREEN") process.exitCode = 1;
