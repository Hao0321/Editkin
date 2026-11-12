// Isolated acceptance of Kit v4 with an imported source outside the project folder.
// Usage: npx tsx scripts/review-kit-external-source-create.ts [--portable <preview.exe>]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createDemoProject } from "../src/domain/demo";
import { runKitWorkflow } from "../src/mcp/kitWorkflowBridge";
import { pinKitProjectExternalSources } from "../src/mcp/kitSourceStaging";

const root = resolve(import.meta.dirname, "..");
const portableIndex = process.argv.indexOf("--portable");
const portable = portableIndex < 0 ? undefined : resolve(process.argv[portableIndex + 1] || "");
if (portable) assert.equal(basename(portable).toLowerCase(), "autopilotdesk-community-preview.exe");
const artifacts = resolve(root, "../artifacts/autopilot-desk");
await mkdir(artifacts, { recursive: true });
const fixture = await mkdtemp(join(artifacts, "kit-external-source-"));
const workspace = join(fixture, "project"), imports = join(fixture, "imports");
await mkdir(workspace); await mkdir(imports);
const source = join(imports, "original.mp4"), projectPath = join(workspace, "movie.editkin.json");
const executableOnPath = (name: string) => execFileSync("where.exe", [name], { encoding: "utf8" }).split(/\r?\n/)[0].trim();
execFileSync(executableOnPath("ffmpeg"), ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
  "testsrc2=size=640x360:rate=30:duration=4", "-vf", "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv",
  "-c:v", "libx264", "-preset", "ultrafast", "-crf", "32", "-pix_fmt", "yuv420p",
  "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-an", "-y", source],
{ stdio: "ignore", timeout: 60_000 });
const project = createDemoProject();
project.id = "kit-external-source-review";
project.name = "Kit external source review";
project.assets[0].id = "asset-source";
project.assets[0].uri = source;
project.assets[0].duration = 4;
project.assets[0].width = 640;
project.assets[0].height = 360;
project.tracks[0].clips[0].id = "clip-source";
project.tracks[0].clips[0].assetId = "asset-source";
project.tracks[0].clips[0].duration = 4;
await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`);
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const projectHash = digest(await readFile(projectPath)), sourceHash = digest(await readFile(source));
const kitSkill = portable ? join(dirname(portable), "resources/video-autopilot-kit/SKILL.md")
  : resolve(root, "../video-tool-research/video-autopilot-kit/codex-skill/video-autopilot/SKILL.md");
process.env.EDITKIN_WORKSPACE = workspace;
process.env.EDITKIN_AGENT_PROJECT_PATH = projectPath;
process.env.EDITKIN_VIDEO_AUTOPILOT_SKILL = kitSkill;
pinKitProjectExternalSources(workspace, projectPath);
const createArgs = { transcriptPolicies: [{ clipId: "clip-source", policy: "visual-only" }] };
const direct = await runKitWorkflow({ command: "create", runId: "external-direct", ...createArgs });
assert.equal(direct.sourceStaging?.copiedExternalSources, 1);
assert.equal((await runKitWorkflow({ command: "next", run: direct.run_dir })).ready[0].step, "contract");
const state = JSON.parse(await readFile(join(direct.run_dir, "workflow-state.json"), "utf8"));
const copied = resolve(workspace, state.binding.materials[0].source_path);
assert.notEqual(copied, source);
assert.equal(digest(await readFile(copied)), sourceHash);
assert.equal(digest(await readFile(source)), sourceHash);
assert.equal(digest(await readFile(projectPath)), projectHash);

let gatewayVerified = false;
if (portable) {
  const resources = join(dirname(portable), "resources/runtime");
  const client = new Client({ name: "editkin-kit-external-source-review", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(resources, "agent-gateway.mjs")], cwd: root,
    env: { ...process.env, EDITKIN_AGENT_GATEWAY_TARGET: join(resources, "mcp.mjs"),
      HAO_FFMPEG_PATH: executableOnPath("ffmpeg"), HAO_FFPROBE_PATH: executableOnPath("ffprobe"),
      EDITKIN_CACHE_ROOT: join(workspace, "cache"), EDITKIN_PLUGIN_ROOTS: join(root, "plugins") } as Record<string, string>, stderr: "pipe" });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, `${name}: ${JSON.stringify(result.content).slice(0, 600)}`);
    const content = result.content.find((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string");
    assert(content);
    return JSON.parse(content.text);
  };
  try {
    await client.connect(transport);
    const created = await call("run_kit_workflow", { command: "create", runId: "external-gateway", ...createArgs });
    assert.equal(created.sourceStaging?.copiedExternalSources, 1);
    const advance = async (step: string, expectedTool: string) => {
      const claim = await call("run_kit_workflow", { command: "claim", run: created.run_dir, step });
      assert.equal(claim.instruction?.tool, expectedTool);
      const executed = await client.callTool({ name: "call_editkin_tool", arguments: {
        name: expectedTool, arguments: claim.instruction.request, retainResult: true, run: created.run_dir,
      } });
      assert.equal(executed.isError, undefined, `${expectedTool}: ${JSON.stringify(executed.content).slice(0, 600)}`);
      const texts = executed.content.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string");
      const result = JSON.parse(texts[0].text);
      assert(["GREEN", "PARTIAL"].includes(result.status));
      const reference = JSON.parse(texts.at(-1)!.text);
      assert(typeof reference.resultRef === "string");
      await call("run_kit_workflow", { command: "complete", run: created.run_dir, step,
        token: claim.claim_token, receiptTemplate: { $resultRef: reference.resultRef } });
      return result;
    };
    await advance("contract", "get_autopilot_contract");
    await advance("session", "start_ai_editing_session");
    const prepared = await advance("prepare:m01-clip-source", "prepare_ai_material");
    assert.equal(prepared.packet?.source?.sourceSha256, sourceHash);
    gatewayVerified = true;
  } finally { await client.close(); }
}
const report = { status: "PASS", originalKitController: true, externalSnapshotVerified: true,
  originalProjectUnchanged: digest(await readFile(projectPath)) === projectHash,
  originalSourceUnchanged: digest(await readFile(source)) === sourceHash, gatewayPreparedExternalSource: gatewayVerified,
  snapshotPath: relative(fixture, copied) };
await writeFile(join(fixture, "review-report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ...report, report: join(fixture, "review-report.json") })}\n`);
