import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { createDemoProject } from "../src/domain/demo";
import { buildEngineRenderGraph } from "../src/render/engineGraph";
import { compileNativeEngineGraph } from "../src/render/nativeCore";

const executable = resolve(process.platform === "win32" ? "native/hao-core/target/debug/hao-core.exe" : "native/hao-core/target/debug/hao-core");
await access(executable);
const project = createDemoProject();
project.captions.push({ id: "integration-caption", text: "同一張圖", start: 1, duration: 2 });
project.motionGraphics.push({
  schema: "hao.motion-composition/v1", id: "integration-title", name: "Integration title", kind: "title", text: "One graph",
  timelineStart: 2, duration: 2, x: .5, y: .2, width: .7, fontSize: 72,
  textColor: "#FFFFFFFF", backgroundColor: "#000000AA", accentColor: "#A8FF3EFF",
  animation: "spring_soft", offsetX: 0, offsetY: 0,
});
const graph = buildEngineRenderGraph(project);
const compiled = await compileNativeEngineGraph(graph, executable);
if (compiled.graphId !== graph.graphId || compiled.outputNode !== graph.outputNode) throw new Error("跨語言 engine graph identity 漂移");
if (!compiled.passes.some((pass) => pass.stage === "decode") || !compiled.passes.some((pass) => pass.stage === "output")) throw new Error("Engine graph 缺少 decode/output pass");
if (compiled.audioNodeCount !== graph.audio?.nodes.length) throw new Error("Audio graph node 數跨語言漂移");
if (!compiled.featureFamilies.includes("caption_rendering") || !compiled.featureFamilies.includes("motion_graphics")) throw new Error("字幕／動態圖沒有進入 native graph contract");
const source = graph.nodes.find((node) => node.id === "source:clip-demo");
const sourceTimeline = source?.timeline as { durationFrames?: number } | undefined;
if (sourceTimeline?.durationFrames !== 360) throw new Error("片段 exact frame range 沒有進入 native graph contract");
process.stdout.write(`${JSON.stringify({ status: "GREEN", graphId: compiled.graphId, passes: compiled.passes.length, audioNodes: compiled.audioNodeCount, features: compiled.featureFamilies })}\n`);
