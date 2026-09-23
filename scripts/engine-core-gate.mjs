import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifest = join(root, "native/hao-core/Cargo.toml");
const fixturePath = join(root, "native/hao-core/fixtures/engine-graph.json");
const cargo = process.env.CARGO || join(homedir(), ".cargo", "bin", process.platform === "win32" ? "cargo.exe" : "cargo");
if (!existsSync(cargo)) throw new Error(`Cargo 不存在：${cargo}`);

function run(executable, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`${executable} 執行逾時`)); }, options.timeoutMs ?? 120_000);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-20_000); });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => { clearTimeout(timeout); resolvePromise({ code, stdout: stdout.trim(), stderr: stderr.trim() }); });
  });
}

const cargoVersion = await run(cargo, ["--version"]);
if (cargoVersion.code !== 0 || !cargoVersion.stdout.startsWith("cargo ")) throw new Error(`Cargo 啟動失敗：${cargoVersion.stderr}`);
const tests = await run(cargo, ["test", "--locked", "--manifest-path", manifest]);
if (tests.code !== 0 || !tests.stdout.includes("test result: ok")) throw new Error(`Engine unit tests 失敗：${tests.stderr || tests.stdout}`);
const build = await run(cargo, ["build", "--locked", "--manifest-path", manifest]);
if (build.code !== 0) throw new Error(`Engine debug build 失敗：${build.stderr || build.stdout}`);

const executable = join(root, "native/hao-core/target/debug", process.platform === "win32" ? "hao-core.exe" : "hao-core");
const capabilitiesResult = await run(executable, ["engine-capabilities"]);
if (capabilitiesResult.code !== 0) throw new Error(capabilitiesResult.stderr);
const capabilities = JSON.parse(capabilitiesResult.stdout);
const selftestResult = await run(executable, ["engine-selftest"]);
if (selftestResult.code !== 0) throw new Error(selftestResult.stderr);
const selftest = JSON.parse(selftestResult.stdout);
if (selftest.status !== "GREEN" || selftest.frameRing?.rejected !== 1 || selftest.deviceRecovery?.generation !== 2 || selftest.scene?.shutterSamples !== 8) {
  throw new Error(`Native engine selftest 失敗：${selftestResult.stdout}`);
}
const compiledResult = await run(executable, ["engine-compile", fixturePath]);
if (compiledResult.code !== 0) throw new Error(compiledResult.stderr);
const compiled = JSON.parse(compiledResult.stdout);
const requiredFeatureFamilies = ["adjustment_layers", "caption_rendering", "motion_graphics", "precomposition"];
if (requiredFeatureFamilies.some((feature) => !compiled.featureFamilies.includes(feature))) {
  throw new Error(`Engine graph 缺少正式專案節點：${JSON.stringify(compiled.featureFamilies)}`);
}
const dirtyResult = await run(executable, ["engine-dirty", fixturePath, "color"]);
if (dirtyResult.code !== 0) throw new Error(dirtyResult.stderr);
const dirty = JSON.parse(dirtyResult.stdout);
if (JSON.stringify(dirty.dirty) !== JSON.stringify(["color", "effect", "composite", "adjustment", "composite-precomp", "composite-caption", "composite-motion", "dof", "motion-blur", "output"])) throw new Error(`dirty propagation 不符合最小 downstream set：${dirtyResult.stdout}`);

const temporary = await mkdtemp(join(tmpdir(), "editkin-engine-gate-"));
const negativeControls = [];
try {
  const cycle = JSON.parse(await readFile(fixturePath, "utf8"));
  cycle.nodes[0].inputs = [cycle.outputNode];
  const cyclePath = join(temporary, "cycle.json");
  await writeFile(cyclePath, JSON.stringify(cycle), "utf8");
  const rejected = await run(executable, ["engine-compile", cyclePath]);
  if (rejected.code === 0 || !rejected.stderr.includes("cycle")) throw new Error("Engine evaluator 未拒絕 dependency cycle negative control");
  negativeControls.push("dependency-cycle-rejected");

  const parentCycle = JSON.parse(await readFile(fixturePath, "utf8"));
  parentCycle.nodes.find((node) => node.id === "transform3d").parent = parentCycle.outputNode;
  const parentCyclePath = join(temporary, "parent-cycle.json");
  await writeFile(parentCyclePath, JSON.stringify(parentCycle), "utf8");
  const parentRejected = await run(executable, ["engine-compile", parentCyclePath]);
  if (parentRejected.code === 0 || !parentRejected.stderr.includes("cycle")) throw new Error("Engine evaluator 未拒絕 implicit parent cycle");
  negativeControls.push("implicit-parent-cycle-rejected");

  const unpairedMatte = JSON.parse(await readFile(fixturePath, "utf8"));
  delete unpairedMatte.nodes.find((node) => node.id === "composite").matteMode;
  const unpairedMattePath = join(temporary, "unpaired-matte.json");
  await writeFile(unpairedMattePath, JSON.stringify(unpairedMatte), "utf8");
  const matteRejected = await run(executable, ["engine-compile", unpairedMattePath]);
  if (matteRejected.code === 0 || !matteRejected.stderr.includes("invalid composite")) throw new Error("Engine evaluator 未拒絕 unpaired track matte");
  negativeControls.push("unpaired-track-matte-rejected");

  const invalidCaption = JSON.parse(await readFile(fixturePath, "utf8"));
  invalidCaption.nodes.find((node) => node.id === "caption").timeline.durationFrames = 0;
  const invalidCaptionPath = join(temporary, "invalid-caption.json");
  await writeFile(invalidCaptionPath, JSON.stringify(invalidCaption), "utf8");
  const captionRejected = await run(executable, ["engine-compile", invalidCaptionPath]);
  if (captionRejected.code === 0 || !captionRejected.stderr.includes("invalid caption")) throw new Error("Engine evaluator 未拒絕 zero-duration caption");
  negativeControls.push("zero-duration-caption-rejected");
} finally {
  await rm(temporary, { recursive: true, force: true });
}

const fixtureBytes = await readFile(fixturePath);
process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  status: "GREEN",
  evaluator: "editkin-engine-core-gate/v1",
  cargo: cargoVersion.stdout,
  fixtureSha256: createHash("sha256").update(fixtureBytes).digest("hex"),
  engineAbiVersion: capabilities.engineAbiVersion,
  passes: compiled.passes.length,
  audioNodes: compiled.audioNodeCount,
  featureFamilies: compiled.featureFamilies,
  selftest,
  dirtyPasses: dirty.dirty,
  negativeControls,
})}\n`);
