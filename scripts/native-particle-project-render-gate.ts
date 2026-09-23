import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { createDemoProject } from "../src/domain/demo";
import { migrateProject, validateProject } from "../src/domain/editGraph";
import { projectSchema } from "../src/domain/schema";
import { DEFAULT_PARTICLE_SIMULATION } from "../src/domain/types";
import { buildEngineRenderGraph } from "../src/render/engineGraph";
import { buildGpuEnginePreviewGraph } from "../src/render/gpuCompositor";

const runFile = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const executable = resolve(root, "native/bin", process.platform === "win32" ? "win32-x64/editkin-gpu-compositor.exe" : process.platform === "darwin" ? "darwin-universal/editkin-gpu-compositor" : "linux-x64/editkin-gpu-compositor");
const reportPath = resolve(root, "../../.rd/benchmarks/editkin-native-particle-project-render/report.json");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function run(args: string[]): Promise<Record<string, any>> {
  const { stdout } = await runFile(executable, args, { cwd: root, timeout: 120_000, windowsHide: true, maxBuffer: 4_000_000 });
  return JSON.parse(stdout) as Record<string, any>;
}

function legacySource(width: number, height: number) {
  return {
    schema: "hao.gpu-render-graph/v1", width, height,
    layers: [{ id: "source", source: { kind: "gradient", start: [9, 12, 28, 255], end: [31, 72, 112, 255], horizontal: false }, blendMode: "normal", opacity: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, enabled: true }],
  };
}

async function main() {
  const temporary = await mkdtemp(join(tmpdir(), "editkin-project-particles-"));
  try {
    const background = join(temporary, "background.png");
    const backgroundSource = join(temporary, "background-source.json");
    await writeFile(backgroundSource, JSON.stringify(legacySource(320, 180)));
    await run(["render", backgroundSource, background, "cpu"]);

    const project = createDemoProject();
    project.width = 320;
    project.height = 180;
    project.assets[0] = { ...project.assets[0], kind: "image", uri: background, width: 320, height: 180 };
    project.particleSimulation = structuredClone(DEFAULT_PARTICLE_SIMULATION);
    const validated = validateProject(project);
    const projectPath = join(temporary, "project.editkin.json");
    await writeFile(projectPath, `${JSON.stringify(validated, null, 2)}\n`);
    const reopened = validateProject(migrateProject(projectSchema.parse(JSON.parse(await readFile(projectPath, "utf8")))));
    const graph = buildEngineRenderGraph(reopened);
    const preview = buildGpuEnginePreviewGraph(reopened, 0.6);
    const graphPath = join(temporary, "engine-graph.json");
    const bindingsPath = join(temporary, "bindings.json");
    const cpuPath = join(temporary, "cpu.png");
    const gpuPath = join(temporary, "gpu.png");
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`);
    await writeFile(bindingsPath, `${JSON.stringify({ "asset-demo": background }, null, 2)}\n`);
    const cpu = await run(["engine-render", graphPath, bindingsPath, "18", cpuPath, "cpu"]);
    const gpu = await run(["engine-render", graphPath, bindingsPath, "18", gpuPath, "gpu"]);
    const requiredNodeIds = graph.nodes.map((node) => node.id);
    const roundTrip = reopened.particleSimulation?.schema === "editkin.particle-simulation/v1"
      && reopened.particleSimulation.ratePerSecond === 48;
    const previewContract = preview?.vfxSimulationExpectation?.emitterCount === 1
      && preview.vfxSimulationExpectation.particleCeiling === 64;
    const green = roundTrip && previewContract && cpu.outputSha256 === gpu.outputSha256
      && gpu.directExecution === true
      && gpu.vfxSimulation?.simulationContract === "screen_space_analytic_particles/v1"
      && gpu.vfxSimulation?.executor === "wgpu-bounded-particle-compute/v1"
      && requiredNodeIds.every((id) => gpu.executedNodeIds.includes(id))
      && gpu.blockedNodeIds.length === 0 && gpu.ignoredNodeIds.length === 0;
    const report = {
      schema: "editkin.native-particle-project-render-gate/v1", status: green ? "GREEN" : "BLOCK",
      persistedProjectRoundTrip: roundTrip, previewContract, graphSchema: graph.schema, graphId: graph.graphId,
      vfxSimulation: gpu.vfxSimulation, cpuGpuOutputParity: cpu.outputSha256 === gpu.outputSha256,
      outputSha256: gpu.outputSha256, requiredNodeIds, executedNodeIds: gpu.executedNodeIds,
      blockedNodeIds: gpu.blockedNodeIds, ignoredNodeIds: gpu.ignoredNodeIds,
      projectSha256: sha256(await readFile(projectPath)), graphSha256: sha256(await readFile(graphPath)), candidateSha256: sha256(await readFile(executable)),
    };
    if (!green) throw new Error(`particle project render integration failed: ${JSON.stringify(report)}`);
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

await main();
