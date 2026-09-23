import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { createDemoProject } from "../src/domain/demo";
import { migrateProject, validateProject } from "../src/domain/editGraph";
import { projectSchema } from "../src/domain/schema";
import { DEFAULT_SCENE_25D, DEFAULT_TRANSFORM_3D } from "../src/domain/types";
import { buildEngineRenderGraph } from "../src/render/engineGraph";

const runFile = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const executable = resolve(root, "native/bin", process.platform === "win32" ? "win32-x64/editkin-gpu-compositor.exe" : process.platform === "darwin" ? "darwin-universal/editkin-gpu-compositor" : "linux-x64/editkin-gpu-compositor");
const reportPath = resolve(root, "../../.rd/benchmarks/editkin-native-25d-project-render/report.json");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function run(args: string[]): Promise<Record<string, any>> {
  const { stdout } = await runFile(executable, args, { cwd: root, timeout: 120_000, windowsHide: true, maxBuffer: 4_000_000 });
  return JSON.parse(stdout) as Record<string, any>;
}

function legacySource(width: number, height: number, source: Record<string, unknown>) {
  return { schema: "hao.gpu-render-graph/v1", width, height, layers: [{ id: "source", source, blendMode: "normal", opacity: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, enabled: true }] };
}

async function main() {
  const temporary = await mkdtemp(join(tmpdir(), "editkin-project-25d-"));
  try {
    const back = join(temporary, "back.png");
    const front = join(temporary, "front.png");
    const backSource = join(temporary, "back-source.json");
    const frontSource = join(temporary, "front-source.json");
    await writeFile(backSource, JSON.stringify(legacySource(320, 180, { kind: "gradient", start: [12, 20, 45, 255], end: [34, 91, 148, 255], horizontal: false })));
    await writeFile(frontSource, JSON.stringify(legacySource(320, 180, { kind: "radial", inner: [255, 226, 85, 255], outer: [220, 42, 25, 0], center: [.5, .5], radius: .47 })));
    await run(["render", backSource, back, "cpu"]);
    await run(["render", frontSource, front, "cpu"]);

    const project = createDemoProject();
    project.width = 320;
    project.height = 180;
    project.assets[0] = { ...project.assets[0], kind: "image", uri: back, width: 320, height: 180 };
    project.assets.push({ id: "front-asset", name: "front", kind: "image", uri: front, duration: 12, width: 320, height: 180 });
    project.scene25d = structuredClone(DEFAULT_SCENE_25D);
    const backClip = project.tracks[0].clips[0];
    backClip.transform3d = { ...structuredClone(DEFAULT_TRANSFORM_3D), scale: [1.3, 1.3, 1] };
    const frontClip = structuredClone(backClip);
    frontClip.id = "front";
    frontClip.assetId = "front-asset";
    frontClip.trackId = "video-front";
    frontClip.transform3d = { position: [.22, -.08, .72], rotationDegrees: [-7, 24, 5], scale: [.56, .56, 1] };
    frontClip.layer = { enabled: true, blendMode: "normal", role: "content", parentClipId: backClip.id };
    project.tracks.push({ id: "video-front", name: "front", kind: "video", locked: false, muted: false, clips: [frontClip] });
    const validated = validateProject(project);
    const projectPath = join(temporary, "project.editkin.json");
    await writeFile(projectPath, `${JSON.stringify(validated, null, 2)}\n`);
    const reopened = validateProject(migrateProject(projectSchema.parse(JSON.parse(await readFile(projectPath, "utf8")))));
    const graph = buildEngineRenderGraph(reopened);
    const graphPath = join(temporary, "engine-graph.json");
    const bindingsPath = join(temporary, "bindings.json");
    const cpuPath = join(temporary, "cpu.png");
    const gpuPath = join(temporary, "gpu.png");
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`);
    await writeFile(bindingsPath, `${JSON.stringify({ "asset-demo": back, "front-asset": front }, null, 2)}\n`);
    const cpu = await run(["engine-render", graphPath, bindingsPath, "0", cpuPath, "cpu"]);
    const gpu = await run(["engine-render", graphPath, bindingsPath, "0", gpuPath, "gpu"]);
    const requiredNodeIds = graph.nodes.map((node) => node.id);
    const green = cpu.outputSha256 === gpu.outputSha256
      && gpu.directExecution === true
      && gpu.scene25d?.sceneContract === "single_camera_textured_planes/v1"
      && gpu.scene25d?.planeCount === 2
      && gpu.scene25d?.parentedPlaneCount === 1
      && requiredNodeIds.every((id) => gpu.executedNodeIds.includes(id))
      && gpu.blockedNodeIds.length === 0 && gpu.ignoredNodeIds.length === 0;
    const report = {
      schema: "editkin.native-25d-project-render-gate/v1", status: green ? "GREEN" : "BLOCK",
      persistedProjectRoundTrip: reopened.scene25d?.schema === "editkin.scene-25d/v1" && reopened.tracks.at(-1)?.clips[0].transform3d?.position[2] === .72,
      graphSchema: graph.schema, graphId: graph.graphId, scene25d: gpu.scene25d,
      cpuGpuOutputParity: cpu.outputSha256 === gpu.outputSha256, outputSha256: gpu.outputSha256,
      requiredNodeIds, executedNodeIds: gpu.executedNodeIds, blockedNodeIds: gpu.blockedNodeIds, ignoredNodeIds: gpu.ignoredNodeIds,
      projectSha256: sha256(await readFile(projectPath)), graphSha256: sha256(await readFile(graphPath)), candidateSha256: sha256(await readFile(executable)),
    };
    if (!green || !report.persistedProjectRoundTrip) throw new Error(`2.5D project render integration failed: ${JSON.stringify(report)}`);
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

await main();
